import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TextFileView,
	WorkspaceLeaf,
	debounce,
	loadPrism,
} from "obsidian";

// Type-only import: gives us Prism's types without bundling prismjs.
// At runtime we use Obsidian's own bundled Prism via loadPrism(), so the
// plugin stays tiny and never conflicts with reading-view highlighting.
import type * as PrismModule from "prismjs";

type PrismInstance = typeof PrismModule;
type PrismToken = PrismModule.Token;
type TokenStream = string | PrismToken | Array<string | PrismToken>;

export const VIEW_TYPE_CODE = "code-file-view";

/** Files larger than this are shown as plain text (highlighting a huge file would freeze the UI). */
const MAX_HIGHLIGHT_CHARS = 1_000_000;

/** Extensions Obsidian handles natively — never try to claim these. */
const RESERVED_EXTENSIONS = new Set([
	"md", "canvas", "pdf",
	"png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif",
	"mp3", "wav", "m4a", "ogg", "3gp", "flac",
	"mp4", "webm", "ogv", "mov", "mkv",
]);

/**
 * Default extension → Prism language id map.
 * "plain" means: open the file in this view, but skip highlighting.
 */
const DEFAULT_EXTENSION_MAP: Record<string, string> = {
	// Python
	py: "python", pyw: "python",
	// JavaScript / TypeScript
	js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
	ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
	// Shell & friends
	sh: "bash", bash: "bash", zsh: "bash", env: "bash",
	ps1: "powershell", psm1: "powershell",
	bat: "batch", cmd: "batch",
	// Data / config
	sql: "sql",
	yml: "yaml", yaml: "yaml",
	toml: "toml",
	ini: "ini", cfg: "ini", conf: "ini",
	properties: "properties",
	json: "json", jsonc: "json", json5: "json",
	// Markup & styles
	xml: "markup", html: "markup", htm: "markup",
	vue: "markup", svelte: "markup",
	css: "css", scss: "scss", less: "less",
	// Compiled languages
	rs: "rust", go: "go", java: "java",
	kt: "kotlin", kts: "kotlin", swift: "swift",
	c: "c", h: "c",
	cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
	cs: "csharp",
	// Scripting & others
	rb: "ruby", php: "php", pl: "perl", pm: "perl",
	lua: "lua", r: "r", jl: "julia", dart: "dart",
	hs: "haskell", ex: "elixir", exs: "elixir",
	dockerfile: "docker", tf: "hcl",
	graphql: "graphql", gql: "graphql",
	diff: "diff", patch: "diff",
	tex: "latex",
	// Plain text
	log: "plain", txt: "plain", text: "plain", csv: "plain", tsv: "plain",
};

interface CodeFileViewerSettings {
	extensionMap: Record<string, string>;
	lineNumbers: boolean;
}

const DEFAULT_SETTINGS: CodeFileViewerSettings = {
	extensionMap: { ...DEFAULT_EXTENSION_MAP },
	lineNumbers: true,
};

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

export default class CodeFileViewerPlugin extends Plugin {
	settings!: CodeFileViewerSettings;
	private prismPromise: Promise<PrismInstance> | null = null;
	private registeredExtensions: string[] = [];

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_CODE, (leaf) => new CodeFileView(leaf, this));
		this.applyExtensions();

		this.addSettingTab(new CodeFileViewerSettingTab(this.app, this));
	}

	/** Lazily fetch Obsidian's bundled Prism instance (shared with reading view). */
	getPrism(): Promise<PrismInstance> {
		if (!this.prismPromise) {
			this.prismPromise = loadPrism() as Promise<PrismInstance>;
		}
		return this.prismPromise;
	}

	/**
	 * (Re-)register the file extensions from settings onto our view.
	 * Registration failures (e.g. another plugin owns the extension) are
	 * logged and skipped so one conflict never breaks the rest.
	 */
	applyExtensions() {
		// Undo our previous registrations first. `viewRegistry` is not part of
		// the public API, so guard every access; worst case the user reloads
		// the plugin for removals to take effect.
		if (this.registeredExtensions.length > 0) {
			const vr = (this.app as unknown as {
				viewRegistry?: { unregisterExtensions?: (exts: string[]) => void };
			}).viewRegistry;
			try {
				vr?.unregisterExtensions?.(this.registeredExtensions);
			} catch (e) {
				console.warn("Code File Viewer: could not unregister old extensions", e);
			}
			this.registeredExtensions = [];
		}

		for (const rawExt of Object.keys(this.settings.extensionMap)) {
			const ext = rawExt.toLowerCase().replace(/^\./, "");
			if (!ext || RESERVED_EXTENSIONS.has(ext)) continue;
			try {
				this.registerExtensions([ext], VIEW_TYPE_CODE);
				this.registeredExtensions.push(ext);
			} catch (e) {
				console.warn(
					`Code File Viewer: could not register ".${ext}" — probably claimed by Obsidian or another plugin.`,
					e
				);
			}
		}
	}

	/** Re-render any open code views (after a settings change). */
	rerenderOpenViews() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CODE)) {
			const view = leaf.view;
			if (view instanceof CodeFileView) void view.render();
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

class CodeFileView extends TextFileView {
	plugin: CodeFileViewerPlugin;
	/** Guards against out-of-order async renders when switching files fast. */
	private renderSeq = 0;

	constructor(leaf: WorkspaceLeaf, plugin: CodeFileViewerPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_CODE;
	}

	getDisplayText(): string {
		return this.file ? this.file.basename : "Code file";
	}

	getIcon(): string {
		return "file-code";
	}

	/* TextFileView contract — we are read-only, so data never changes. */

	getViewData(): string {
		return this.data;
	}

	setViewData(data: string, _clear: boolean): void {
		this.data = data;
		void this.render();
	}

	clear(): void {
		this.data = "";
		this.contentEl.empty();
	}

	async render(): Promise<void> {
		const seq = ++this.renderSeq;
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("cfv-view-content");

		const ext = this.file?.extension?.toLowerCase() ?? "";
		const langId = this.plugin.settings.extensionMap[ext] ?? "plain";

		/* Toolbar ------------------------------------------------------ */
		const toolbar = contentEl.createDiv({ cls: "cfv-toolbar" });
		const info = toolbar.createDiv({ cls: "cfv-toolbar-info" });
		info.createSpan({
			cls: "cfv-lang",
			text: ext ? `.${ext} · ${langId}` : langId,
		});
		const note = info.createSpan({ cls: "cfv-note" });

		const copyBtn = toolbar.createEl("button", {
			cls: "cfv-copy",
			text: "Copy",
		});
		copyBtn.setAttr("aria-label", "Copy file contents");
		copyBtn.addEventListener("click", () => {
			void navigator.clipboard.writeText(this.data).then(() => {
				new Notice("File contents copied");
			});
		});

		/* Code area ----------------------------------------------------- */
		const scroller = contentEl.createDiv({ cls: "cfv-scroller" });
		const wrap = scroller.createDiv({ cls: "cfv-codewrap" });

		if (this.plugin.settings.lineNumbers) {
			let count = this.data.split("\n").length;
			if (this.data.endsWith("\n")) count -= 1;
			count = Math.max(count, 1);
			const gutterText = Array.from({ length: count }, (_, i) =>
				String(i + 1)
			).join("\n");
			const gutter = wrap.createEl("pre", {
				cls: "cfv-gutter",
				text: gutterText,
			});
			gutter.setAttr("aria-hidden", "true");
		}

		const pre = wrap.createEl("pre", { cls: "cfv-pre" });
		const code = pre.createEl("code", { cls: `language-${langId}` });

		/* Highlight ------------------------------------------------------ */
		let prism: PrismInstance | null = null;
		let grammar: PrismModule.Grammar | undefined;

		const tooLarge = this.data.length > MAX_HIGHLIGHT_CHARS;
		if (langId !== "plain" && !tooLarge) {
			try {
				prism = await this.plugin.getPrism();
			} catch (e) {
				console.warn("Code File Viewer: loadPrism() failed", e);
			}
			// A newer render started while we awaited Prism — abandon this one.
			if (seq !== this.renderSeq) return;
			grammar = prism?.languages?.[langId] ?? prism?.languages?.[ext];
		}

		if (prism && grammar) {
			const tokens = prism.tokenize(this.data, grammar) as TokenStream;
			appendTokenStream(code, tokens);
		} else {
			code.setText(this.data);
			if (langId !== "plain") {
				note.setText(
					tooLarge
						? "highlighting off (large file)"
						: `no grammar for "${langId}" — plain text`
				);
			}
		}
	}
}

/**
 * Convert a Prism token stream into DOM nodes.
 * Building nodes directly (instead of innerHTML) keeps us aligned with
 * Obsidian's plugin guidelines and avoids any HTML-injection surface.
 */
function appendTokenStream(parent: HTMLElement, stream: TokenStream): void {
	if (typeof stream === "string") {
		parent.appendText(stream);
		return;
	}
	if (Array.isArray(stream)) {
		for (const part of stream) appendTokenStream(parent, part);
		return;
	}
	// Single token
	const classes = ["token", stream.type];
	const alias = stream.alias;
	if (alias) {
		if (Array.isArray(alias)) classes.push(...alias);
		else classes.push(alias);
	}
	const span = parent.createSpan({ cls: classes });
	appendTokenStream(span, stream.content as TokenStream);
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export function parseMappings(text: string): Record<string, string> {
	const map: Record<string, string> = {};
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const match = line.match(/^\.?([\w+-]+)\s*[:=]\s*([\w+-]+)$/);
		if (match) map[match[1].toLowerCase()] = match[2].toLowerCase();
	}
	return map;
}

function formatMappings(map: Record<string, string>): string {
	return Object.keys(map)
		.sort()
		.map((ext) => `${ext}: ${map[ext]}`)
		.join("\n");
}

class CodeFileViewerSettingTab extends PluginSettingTab {
	plugin: CodeFileViewerPlugin;

	constructor(app: App, plugin: CodeFileViewerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Line numbers")
			.setDesc("Show a line-number gutter next to the code.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.lineNumbers)
					.onChange(async (value) => {
						this.plugin.settings.lineNumbers = value;
						await this.plugin.saveSettings();
						this.plugin.rerenderOpenViews();
					})
			);

		const applyMappings = debounce(
			async (value: string) => {
				this.plugin.settings.extensionMap = parseMappings(value);
				await this.plugin.saveSettings();
				this.plugin.applyExtensions();
				this.plugin.rerenderOpenViews();
			},
			800,
			true
		);

		new Setting(containerEl)
			.setName("Extension → language mappings")
			.setDesc(
				'One mapping per line, in the form "extension: language". ' +
					'Language ids are the same ones you use in ```lang code blocks. ' +
					'Use "plain" to open a file type without highlighting. ' +
					"Lines starting with # are ignored. If removing an extension " +
					"doesn't take effect, toggle the plugin off and on."
			)
			.addTextArea((ta) => {
				ta.setValue(formatMappings(this.plugin.settings.extensionMap));
				ta.onChange(applyMappings);
				ta.inputEl.rows = 14;
				ta.inputEl.addClass("cfv-settings-textarea");
			});

		new Setting(containerEl)
			.setName("Restore default mappings")
			.setDesc("Replace the list above with the plugin's built-in defaults.")
			.addButton((btn) =>
				btn.setButtonText("Restore defaults").onClick(async () => {
					this.plugin.settings.extensionMap = { ...DEFAULT_EXTENSION_MAP };
					await this.plugin.saveSettings();
					this.plugin.applyExtensions();
					this.plugin.rerenderOpenViews();
					this.display();
				})
			);
	}
}
