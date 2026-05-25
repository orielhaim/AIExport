const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");
const { WEBVIEW_ASSET_PATHS } = require("../config/constants");
const { FileTreeService } = require("../services/file-tree-service");
const { debounce } = require("../utils/debounce");

class AIExportSidebarProvider {
	/**
	 * @param {vscode.ExtensionContext} context
	 */
	constructor(context) {
		this._context = context;
		this._fileTreeService = new FileTreeService();
		/** @type {vscode.WebviewView | undefined} */
		this._webviewView = undefined;
		/** @type {vscode.FileSystemWatcher | undefined} */
		this._watcher = undefined;
		this._refreshTreeDebounced = debounce(() => {
			void this.refreshTree({ preserveSelection: true });
		}, 200);
	}

	dispose() {
		this._watcher?.dispose();
	}

	/**
	 * @param {vscode.WebviewView} webviewView
	 */
	resolveWebviewView(webviewView) {
		this._webviewView = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._context.extensionUri],
		};

		this._ensureWorkspaceWatcher();
		void this._setWebviewHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(async (message) => {
			switch (message.command) {
				case "ready":
				case "getFiles":
					await this.refreshTree({ preserveSelection: true });
					break;
				case "exportFiles":
					await this._handleExportFiles(message.files, {
						stripComments: message.stripComments ?? false,
					});
					break;
				case "getStats":
					await this._handleGetStats(message.files);
					break;
				case "copyToClipboard":
					await vscode.env.clipboard.writeText(message.text ?? "");
					void vscode.window.showInformationMessage(
						"AIExport: Copied to clipboard",
					);
					break;
				case "openFile": {
					const rootPath = this._getWorkspaceRootPath();
					if (rootPath && message.filePath) {
						const uri = vscode.Uri.file(path.join(rootPath, message.filePath));
						void vscode.window.showTextDocument(uri, { preview: true });
					}
					break;
				}
				case "saveToFile": {
					const uri = await vscode.window.showSaveDialog({
						defaultUri: vscode.Uri.file("export.txt"),
						filters: { "Text files": ["txt", "md"], "All files": ["*"] },
					});
					if (uri && message.text) {
						await vscode.workspace.fs.writeFile(
							uri,
							Buffer.from(message.text, "utf8"),
						);
						void vscode.window.showInformationMessage(
							"AIExport: Saved to file",
						);
					}
					break;
				}
			}
		});
	}

	async refreshTree(options = { preserveSelection: true }) {
		const rootPath = this._getWorkspaceRootPath();
		if (!rootPath || !this._webviewView) return;

		this._fileTreeService.invalidate();
		const tree = await this._fileTreeService.getFileTree(rootPath);
		this._postMessage({
			command: "fileTree",
			data: tree,
			preserveSelection: options.preserveSelection,
		});
	}

	/**
	 * @param {string[]} filePaths
	 * @param {{ stripComments: boolean }} options
	 */
	async _handleExportFiles(filePaths, options) {
		const rootPath = this._getWorkspaceRootPath();
		if (!rootPath) {
			this._postMessage({ command: "exportResult", data: "" });
			return;
		}

		const result = await this._fileTreeService.exportFiles(
			rootPath,
			Array.isArray(filePaths) ? filePaths : [],
			{ stripComments: options.stripComments },
		);

		this._postMessage({ command: "exportResult", data: result });
	}

	async _handleGetStats(filePaths) {
		const rootPath = this._getWorkspaceRootPath();
		if (!rootPath) {
			this._postMessage({ command: "statsResult", data: null });
			return;
		}

		const stats = await this._fileTreeService.getStats(
			rootPath,
			Array.isArray(filePaths) ? filePaths : [],
		);

		this._postMessage({ command: "statsResult", data: stats });
	}

	_ensureWorkspaceWatcher() {
		if (this._watcher) return;

		this._watcher = vscode.workspace.createFileSystemWatcher("**/*");
		const handleChange = (uri) => {
			if (this._shouldIgnoreUri(uri)) return;
			this._refreshTreeDebounced();
		};

		this._watcher.onDidChange(handleChange);
		this._watcher.onDidCreate(handleChange);
		this._watcher.onDidDelete(handleChange);
	}

	_shouldIgnoreUri(uri) {
		const rootPath = this._getWorkspaceRootPath();
		if (!rootPath) return true;

		const relativePath = path
			.relative(rootPath, uri.fsPath)
			.replace(/\\/g, "/");
		return (
			!relativePath ||
			relativePath.startsWith("../") ||
			relativePath.includes("/node_modules/") ||
			relativePath.includes("/.git/")
		);
	}

	_getWorkspaceRootPath() {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	async _setWebviewHtml(webview) {
		const extensionPath = this._context.extensionUri.fsPath;
		const [scriptContent, styleContent] = await Promise.all([
			fs.readFile(path.join(extensionPath, WEBVIEW_ASSET_PATHS.js), "utf8"),
			fs.readFile(path.join(extensionPath, WEBVIEW_ASSET_PATHS.css), "utf8"),
		]);

		webview.html = this._buildHtml(webview, scriptContent, styleContent);
	}

	_buildHtml(webview, scriptContent, styleContent) {
		const nonce = String(Date.now());
		const csp = [
			"default-src 'none'",
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src 'nonce-${nonce}'`,
		].join("; ");

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<title>AIExport</title>
	<style>${styleContent}</style>
</head>
<body>
	<div class="app">
		<div class="header">
			<span class="header-title">AIExport</span>
			<span class="header-badge" id="sync-indicator">Ready</span>
		</div>

		<div class="toolbar">
			<button type="button" class="btn btn-icon" data-action="refresh" title="Refresh file tree">
				<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
					<path d="M13.451 5.609l-.579-.939-1.068.812-.076.094c.335.57.528 1.236.528 1.949 0 2.044-1.588 3.713-3.587 3.842l.9-.807-.684-.764-2.121 1.903 2.121 1.903.684-.764-.831-.745c2.58-.166 4.618-2.326 4.618-4.968 0-.791-.186-1.537-.516-2.2l.611-.316zM7.447 3.073l-.684.764.831.745c-2.58.166-4.618 2.326-4.618 4.968 0 .791.186 1.538.516 2.2l-.611.316.579.939 1.068-.813.076-.094a3.846 3.846 0 01-.528-1.949c0-2.044 1.588-3.713 3.587-3.842l-.9.807.684.764L9.568 4.98 7.447 3.073z"/>
				</svg>
			</button>
			<button type="button" class="btn btn-sm" data-action="select-all">Select All</button>
			<button type="button" class="btn btn-sm btn-ghost" data-action="clear-selection">Clear</button>
		</div>

		<div class="search-container">
			<input type="text" class="search-input" id="search-input" placeholder="Filter files..." />
			<span class="search-clear hidden" id="search-clear">&times;</span>
		</div>

		<div class="stats-bar" id="stats-bar">
			<span class="stat-primary" id="count-info">0 files selected</span>
			<span class="stat-detail" id="word-count" title="Hover for details">0 words</span>
		</div>

		<div class="tooltip" id="stats-tooltip"></div>

		<div id="file-tree" class="file-tree"></div>

		<div class="export-section">
			<div class="export-options">
				<label class="option-label" title="Remove comments from exported code">
					<input type="checkbox" id="strip-comments-toggle" />
					<span>Strip comments</span>
				</label>
			</div>
			<button type="button" class="btn btn-primary btn-export" data-action="export">
				<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="margin-right:4px">
					<path d="M8 1L3 6h3v5h4V6h3L8 1zm6 10v3H2v-3H1v4h14v-4h-1z"/>
				</svg>
				Export Selected
			</button>

			<div id="output-area" class="output-area hidden">
				<div class="output-header">
					<span class="output-title">Export Output</span>
					<span class="output-stats" id="output-stats"></span>
				</div>
				<textarea id="output-text" readonly></textarea>
				<div class="output-actions">
					<button type="button" class="btn btn-sm btn-primary" data-action="copy">
						Copy to Clipboard
					</button>
					<button type="button" class="btn btn-sm btn-ghost" data-action="save-file">
						Save to File
					</button>
				</div>
			</div>
		</div>
	</div>

	<script nonce="${nonce}">${scriptContent}</script>
</body>
</html>`;
	}

	_postMessage(message) {
		this._webviewView?.webview.postMessage(message);
	}
}

module.exports = { AIExportSidebarProvider };
