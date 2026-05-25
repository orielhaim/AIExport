// @ts-nocheck
const vscode = acquireVsCodeApi();

/** @type {Array<any>} */
let fileTree = [];
/** @type {Set<string>} */
let checkedFiles = new Set();
/** @type {Set<string>} */
const expandedFolders = new Set();
/** @type {string} */
let searchQuery = "";
/** @type {{ words: number, characters: number, lines: number, files: number } | null} */
let currentStats = null;

// Restore persisted state
const state = vscode.getState();
if (state?.checkedFiles) {
	checkedFiles = new Set(state.checkedFiles);
}
if (state?.expandedFolders) {
	state.expandedFolders.forEach((f) => expandedFolders.add(f));
}

const elements = {
	countInfo: document.getElementById("count-info"),
	fileTree: document.getElementById("file-tree"),
	outputArea: document.getElementById("output-area"),
	outputText: document.getElementById("output-text"),
	outputStats: document.getElementById("output-stats"),
	syncIndicator: document.getElementById("sync-indicator"),
	searchInput: document.getElementById("search-input"),
	searchClear: document.getElementById("search-clear"),
	wordCount: document.getElementById("word-count"),
	statsTooltip: document.getElementById("stats-tooltip"),
	stripCommentsToggle: document.getElementById("strip-comments-toggle"),
};

const checkboxRegistry = new Map();

const itemRegistry = new Map();

// ── Message Handler ──

window.addEventListener("message", (event) => {
	const message = event.data;

	switch (message.command) {
		case "fileTree":
			fileTree = Array.isArray(message.data) ? message.data : [];
			reconcileSelection(fileTree);
			rebuildTree();
			setSyncState("Updated");
			requestStats();
			break;
		case "exportResult":
			elements.outputArea.classList.remove("hidden");
			elements.outputText.value = message.data ?? "";
			updateOutputStats(message.data ?? "");
			setSyncState("Ready");
			break;
		case "statsResult":
			if (message.data) {
				currentStats = message.data;
				renderWordCount();
			}
			break;
	}
});

// ── Click Delegation ──

document.addEventListener("click", (event) => {
	const target = event.target.closest("[data-action]");
	const action = target?.dataset.action;
	if (!action) return;

	switch (action) {
		case "refresh":
			setSyncState("Refreshing…", true);
			vscode.postMessage({ command: "getFiles" });
			break;
		case "select-all":
			selectAllFiles(fileTree);
			refreshCheckboxes();
			requestStats();
			break;
		case "clear-selection":
			checkedFiles.clear();
			persistState();
			refreshCheckboxes();
			requestStats();
			break;
		case "export":
			exportSelected();
			break;
		case "copy":
			if (elements.outputText.value) {
				vscode.postMessage({
					command: "copyToClipboard",
					text: elements.outputText.value,
				});
			}
			break;
		case "save-file":
			if (elements.outputText.value) {
				vscode.postMessage({
					command: "saveToFile",
					text: elements.outputText.value,
				});
			}
			break;
	}
});

// ── Search ──

elements.searchInput.addEventListener("input", () => {
	searchQuery = elements.searchInput.value.trim().toLowerCase();
	elements.searchClear.classList.toggle("hidden", !searchQuery);
	rebuildTree();
});

elements.searchClear.addEventListener("click", () => {
	elements.searchInput.value = "";
	searchQuery = "";
	elements.searchClear.classList.add("hidden");
	rebuildTree();
});

// ── Word Count Tooltip ──

let tooltipTimeout;

elements.wordCount.addEventListener("mouseenter", () => {
	if (!currentStats) return;
	const rect = elements.wordCount.getBoundingClientRect();
	const tooltip = elements.statsTooltip;

	tooltip.innerHTML = [
		`<strong>${currentStats.files}</strong> files`,
		`<strong>${currentStats.words.toLocaleString()}</strong> words`,
		`<strong>${currentStats.characters.toLocaleString()}</strong> characters`,
		`<strong>${currentStats.lines.toLocaleString()}</strong> lines`,
		`<strong>~${Math.ceil(currentStats.words / 0.75).toLocaleString()}</strong> tokens (est.)`,
	].join("<br>");

	tooltip.style.left = `${rect.left}px`;
	tooltip.style.top = `${rect.bottom + 6}px`;

	tooltipTimeout = setTimeout(() => {
		tooltip.classList.add("visible");
	}, 80);
});

elements.wordCount.addEventListener("mouseleave", () => {
	clearTimeout(tooltipTimeout);
	elements.statsTooltip.classList.remove("visible");
});

// ── Init ──

vscode.postMessage({ command: "ready" });

// ── Full rebuild (structure changed) ──

function rebuildTree() {
	// Save scroll position
	const scrollTop = elements.fileTree.scrollTop;

	elements.fileTree.innerHTML = "";
	checkboxRegistry.clear();
	itemRegistry.clear();

	const filtered = searchQuery ? filterTree(fileTree, searchQuery) : fileTree;

	if (filtered.length === 0) {
		const empty = document.createElement("div");
		empty.className = "empty-state";
		empty.innerHTML = searchQuery
			? `<span class="empty-state-icon">🔍</span><span>No files match "<strong>${escapeHtml(searchQuery)}</strong>"</span>`
			: `<span class="empty-state-icon">📭</span><span>No files found</span>`;
		elements.fileTree.appendChild(empty);
		updateCount();
		return;
	}

	const fragment = document.createDocumentFragment();
	appendItems(fragment, filtered, 0);
	elements.fileTree.appendChild(fragment);

	elements.fileTree.scrollTop = scrollTop;

	updateCount();
}

function refreshCheckboxes() {
	for (const [itemPath, checkbox] of checkboxRegistry) {
		const item = itemRegistry.get(itemPath);
		if (!item) continue;

		checkbox.checked = isItemChecked(item);
		checkbox.indeterminate = isItemIndeterminate(item);
	}
	updateCount();
}

function appendItems(container, items, depth) {
	for (const item of items) {
		itemRegistry.set(item.path, item);

		const row = document.createElement("div");
		row.className = "tree-row";

		for (let i = 0; i < depth; i++) {
			const indent = document.createElement("span");
			indent.className = "indent";
			row.appendChild(indent);
		}

		const toggle = document.createElement("span");
		toggle.className = "toggle";
		const hasChildren = item.type === "folder" && item.children?.length;
		const isExpanded =
			expandedFolders.has(item.path) || (searchQuery && hasChildren);

		if (hasChildren) {
			toggle.classList.add("is-clickable");
			toggle.textContent = isExpanded ? "▾" : "▸";
		}
		row.appendChild(toggle);

		// Checkbox
		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.className = "checkbox";
		checkbox.checked = isItemChecked(item);
		checkbox.indeterminate = isItemIndeterminate(item);
		row.appendChild(checkbox);

		// Register checkbox for fast patching
		checkboxRegistry.set(item.path, checkbox);

		// Icon
		const icon = document.createElement("span");
		icon.className = "icon";
		if (item.type === "folder") {
			icon.textContent = isExpanded ? "📂" : "📁";
		} else {
			icon.textContent = getFileIcon(item.name);
		}
		row.appendChild(icon);

		// Label
		const label = document.createElement("span");
		label.className = item.type === "file" ? "label is-clickable" : "label";
		label.textContent = item.name;
		if (item.type === "file") {
			label.title = item.path;
		}
		row.appendChild(label);

		// File size
		if (item.type === "file" && item.size != null) {
			const size = document.createElement("span");
			size.className = "file-size";
			size.textContent = formatSize(item.size);
			row.appendChild(size);
		}

		container.appendChild(row);

		// Folder children
		if (item.type === "folder") {
			const children = document.createElement("div");
			children.className = isExpanded ? "children open" : "children";
			appendItems(children, item.children ?? [], depth + 1);
			container.appendChild(children);

			const toggleFolder = () => {
				if (!hasChildren) return;
				if (expandedFolders.has(item.path)) {
					expandedFolders.delete(item.path);
				} else {
					expandedFolders.add(item.path);
				}
				persistState();
				rebuildTree();
			};

			toggle.addEventListener("click", toggleFolder);
			label.addEventListener("click", toggleFolder);

			checkbox.addEventListener("change", () => {
				const paths = getAllFiles(item);
				if (checkbox.checked) {
					paths.forEach((f) => checkedFiles.add(f));
				} else {
					paths.forEach((f) => checkedFiles.delete(f));
				}
				persistState();
				refreshCheckboxes();
				requestStats();
			});
			continue;
		}

		// File click → open in editor
		label.addEventListener("click", () => {
			vscode.postMessage({ command: "openFile", filePath: item.path });
		});

		checkbox.addEventListener("change", () => {
			if (checkbox.checked) {
				checkedFiles.add(item.path);
			} else {
				checkedFiles.delete(item.path);
			}
			persistState();
			refreshCheckboxes();
			requestStats();
		});
	}
}

// ── Search / Filter ──

function filterTree(items, query) {
	const result = [];
	for (const item of items) {
		if (item.type === "file") {
			if (
				item.name.toLowerCase().includes(query) ||
				item.path.toLowerCase().includes(query)
			) {
				result.push(item);
			}
			continue;
		}

		const filteredChildren = filterTree(item.children ?? [], query);
		if (
			filteredChildren.length > 0 ||
			item.name.toLowerCase().includes(query)
		) {
			result.push({
				...item,
				children:
					filteredChildren.length > 0 ? filteredChildren : item.children,
			});
		}
	}
	return result;
}

// ── File Helpers ──

function getFileIcon(name) {
	const ext = name.includes(".")
		? name.slice(name.lastIndexOf(".")).toLowerCase()
		: "";
	const map = {
		".js": "📜",
		".jsx": "⚛️",
		".ts": "🔷",
		".tsx": "⚛️",
		".json": "📋",
		".md": "📝",
		".html": "🌐",
		".htm": "🌐",
		".css": "🎨",
		".scss": "🎨",
		".less": "🎨",
		".py": "🐍",
		".rb": "💎",
		".go": "🔵",
		".rs": "🦀",
		".java": "☕",
		".php": "🐘",
		".sh": "🐚",
		".bash": "🐚",
		".yml": "⚙️",
		".yaml": "⚙️",
		".toml": "⚙️",
		".sql": "🗃️",
		".vue": "💚",
		".svelte": "🔥",
		".xml": "📰",
		".svg": "🖼️",
		".gitignore": "🙈",
		".env": "🔐",
		".env.example": "🔐",
	};
	if (name === ".gitignore") return "🙈";
	return map[ext] || "📄";
}

function formatSize(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getAllFiles(item) {
	if (item.type === "file") return [item.path];
	return (item.children ?? []).flatMap((child) => getAllFiles(child));
}

function isItemChecked(item) {
	if (item.type === "file") return checkedFiles.has(item.path);
	const files = getAllFiles(item);
	return files.length > 0 && files.every((f) => checkedFiles.has(f));
}

function isItemIndeterminate(item) {
	if (item.type === "file") return false;
	const files = getAllFiles(item);
	const count = files.filter((f) => checkedFiles.has(f)).length;
	return count > 0 && count < files.length;
}

function selectAllFiles(items) {
	for (const item of items) {
		if (item.type === "file") {
			checkedFiles.add(item.path);
			continue;
		}
		expandedFolders.add(item.path);
		selectAllFiles(item.children ?? []);
	}
	persistState();
}

function reconcileSelection(items) {
	const available = new Set(collectFiles(items));
	checkedFiles = new Set([...checkedFiles].filter((f) => available.has(f)));
	expandedFolders.forEach((folder) => {
		if (!folderExists(items, folder)) expandedFolders.delete(folder);
	});
	persistState();
}

function collectFiles(items) {
	return items.flatMap((item) => getAllFiles(item));
}

function folderExists(items, pathToFind) {
	for (const item of items) {
		if (item.type === "folder" && item.path === pathToFind) return true;
		if (item.type === "folder" && folderExists(item.children ?? [], pathToFind))
			return true;
	}
	return false;
}

// ── Stats ──

function requestStats() {
	if (checkedFiles.size === 0) {
		currentStats = { words: 0, characters: 0, lines: 0, files: 0 };
		renderWordCount();
		return;
	}

	vscode.postMessage({
		command: "getStats",
		files: [...checkedFiles].sort(),
	});
}

function renderWordCount() {
	if (!currentStats) {
		elements.wordCount.textContent = "0 words";
		return;
	}
	elements.wordCount.textContent = `${currentStats.words.toLocaleString()} words`;
}

function updateCount() {
	elements.countInfo.textContent = `${checkedFiles.size} file${checkedFiles.size !== 1 ? "s" : ""} selected`;
}

function updateOutputStats(text) {
	const words = text.split(/\s+/).filter(Boolean).length;
	const lines = text.split("\n").length;
	elements.outputStats.textContent = `${words.toLocaleString()} words · ${lines.toLocaleString()} lines`;
}

// ── Export ──

function exportSelected() {
	if (checkedFiles.size === 0) return;

	setSyncState("Exporting…", true);
	const stripComments = elements.stripCommentsToggle?.checked ?? false;

	vscode.postMessage({
		command: "exportFiles",
		files: [...checkedFiles].sort(),
		stripComments,
	});
}

// ── Persistence ──

function persistState() {
	vscode.setState({
		checkedFiles: [...checkedFiles],
		expandedFolders: [...expandedFolders],
	});
}

// ── UI State ──

function setSyncState(label, busy = false) {
	elements.syncIndicator.textContent = label;
	elements.syncIndicator.classList.toggle("is-busy", busy);
}

// ── Utilities ──

function escapeHtml(str) {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
