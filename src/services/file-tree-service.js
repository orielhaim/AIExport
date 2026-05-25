const fs = require("node:fs/promises");
const path = require("node:path");
const {
	ALLOWED_HIDDEN_NAMES,
	BINARY_EXTENSIONS,
	IGNORED_NAMES,
	MAX_FILE_SIZE_BYTES,
} = require("../config/constants");
const { CommentStripper } = require("./comment-stripper");

class FileTreeService {
	constructor() {
		this._cachedRootPath = undefined;
		/** @type {Array<any>} */
		this._cachedTree = [];
		this._commentStripper = new CommentStripper();
	}

	invalidate() {
		this._cachedRootPath = undefined;
		this._cachedTree = [];
	}

	async getFileTree(rootPath) {
		if (this._cachedRootPath === rootPath && this._cachedTree.length > 0) {
			return this._cachedTree;
		}

		const tree = await this._buildTree(rootPath, rootPath);
		this._cachedRootPath = rootPath;
		this._cachedTree = tree;
		return tree;
	}

	/**
	 * @param {string} rootPath
	 * @param {string[]} filePaths
	 * @param {{ stripComments?: boolean }} options
	 * @returns {Promise<string>}
	 */
	async exportFiles(rootPath, filePaths, options = {}) {
		const normalizedPaths = [...new Set(filePaths)].sort();
		const parts = await Promise.all(
			normalizedPaths.map(async (filePath) => {
				const safePath = this._normalizeExportPath(rootPath, filePath);
				if (!safePath) {
					return `/${filePath}\n[File is outside the workspace]`;
				}

				try {
					const stat = await fs.stat(safePath);
					if (stat.size > MAX_FILE_SIZE_BYTES) {
						return `/${filePath}\n[File too large: ${(stat.size / 1024).toFixed(1)} KB]`;
					}

					let content = await fs.readFile(safePath, "utf8");

					if (options.stripComments) {
						content = this._commentStripper.strip(filePath, content);
					}

					return `/${filePath}\n${content}`;
				} catch {
					return `/${filePath}\n[Error reading file]`;
				}
			}),
		);

		return parts.join("\n----------\n");
	}

	/**
	 * Get stats for an array of file paths without reading full content.
	 * @param {string} rootPath
	 * @param {string[]} filePaths
	 * @returns {Promise<{ words: number, characters: number, lines: number, files: number }>}
	 */
	async getStats(rootPath, filePaths) {
		let words = 0;
		let characters = 0;
		let lines = 0;
		const files = filePaths.length;

		await Promise.all(
			filePaths.map(async (filePath) => {
				const safePath = this._normalizeExportPath(rootPath, filePath);
				if (!safePath) {
					return;
				}

				try {
					const stat = await fs.stat(safePath);
					if (stat.size > MAX_FILE_SIZE_BYTES) {
						return;
					}

					const content = await fs.readFile(safePath, "utf8");
					characters += content.length;
					lines += content.split("\n").length;
					words += content.split(/\s+/).filter(Boolean).length;
				} catch {
					// skip unreadable files
				}
			}),
		);

		return { words, characters, lines, files };
	}

	async _buildTree(dirPath, rootPath) {
		/** @type {Array<{name: string, path: string, type: "folder" | "file", children?: any[], size?: number}>} */
		const items = [];

		let entries;
		try {
			entries = await fs.readdir(dirPath, { withFileTypes: true });
		} catch {
			return items;
		}

		entries.sort((left, right) => {
			if (left.isDirectory() && !right.isDirectory()) return -1;
			if (!left.isDirectory() && right.isDirectory()) return 1;
			return left.name.localeCompare(right.name);
		});

		await Promise.all(
			entries.map(async (entry) => {
				if (this._shouldIgnore(entry.name)) return;

				const fullPath = path.join(dirPath, entry.name);
				const relativePath = path
					.relative(rootPath, fullPath)
					.replace(/\\/g, "/");

				if (entry.isDirectory()) {
					const children = await this._buildTree(fullPath, rootPath);
					if (children.length > 0) {
						items.push({
							name: entry.name,
							path: relativePath,
							type: "folder",
							children,
						});
					}
					return;
				}

				if (this._isBinaryFile(entry.name)) return;

				try {
					const stat = await fs.stat(fullPath);
					items.push({
						name: entry.name,
						path: relativePath,
						type: "file",
						size: stat.size,
					});
				} catch {
					items.push({
						name: entry.name,
						path: relativePath,
						type: "file",
						size: 0,
					});
				}
			}),
		);

		items.sort((left, right) => {
			if (left.type === "folder" && right.type !== "folder") return -1;
			if (left.type !== "folder" && right.type === "folder") return 1;
			return left.name.localeCompare(right.name);
		});

		return items;
	}

	_shouldIgnore(name) {
		if (IGNORED_NAMES.has(name)) return true;
		return name.startsWith(".") && !ALLOWED_HIDDEN_NAMES.has(name);
	}

	_isBinaryFile(filename) {
		return BINARY_EXTENSIONS.has(path.extname(filename).toLowerCase());
	}

	_normalizeExportPath(rootPath, filePath) {
		const normalizedPath = path.resolve(rootPath, filePath);
		const relativePath = path.relative(rootPath, normalizedPath);
		if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
			return undefined;
		}
		return normalizedPath;
	}
}

module.exports = { FileTreeService };
