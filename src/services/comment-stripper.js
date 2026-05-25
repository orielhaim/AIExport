const path = require("node:path");
const {
	COMMENT_SYNTAX,
	EXTENSION_COMMENT_MAP,
} = require("../config/constants");

class CommentStripper {
	/**
	 * Strip comments from file content based on file extension.
	 * @param {string} filePath
	 * @param {string} content
	 * @returns {string}
	 */
	strip(filePath, content) {
		const ext = path.extname(filePath).toLowerCase();
		const syntaxKey = EXTENSION_COMMENT_MAP[ext];

		if (!syntaxKey) {
			return content;
		}

		const syntax = COMMENT_SYNTAX[syntaxKey];
		if (!syntax) {
			return content;
		}

		// For HTML-style comments, use a different approach
		if (syntaxKey === "html") {
			return this._stripHtmlComments(content, syntax);
		}

		return this._stripComments(content, syntax);
	}

	/**
	 * @param {string} content
	 * @param {{ line: string | null, blockStart: string | null, blockEnd: string | null }} syntax
	 * @returns {string}
	 */
	_stripComments(content, syntax) {
		const chars = content;
		const len = chars.length;
		let result = "";
		let i = 0;
		let inString = false;
		let stringChar = "";
		let inTemplateString = false;
		let templateDepth = 0;

		while (i < len) {
			// Handle string literals – don't strip inside strings
			if (!inString && !inTemplateString) {
				if (chars[i] === '"' || chars[i] === "'") {
					inString = true;
					stringChar = chars[i];
					result += chars[i];
					i++;
					continue;
				}

				if (chars[i] === "`") {
					inTemplateString = true;
					templateDepth = 1;
					result += chars[i];
					i++;
					continue;
				}

				// Block comment
				if (syntax.blockStart && chars.startsWith(syntax.blockStart, i)) {
					const endIdx = chars.indexOf(
						syntax.blockEnd,
						i + syntax.blockStart.length,
					);
					if (endIdx === -1) {
						// Unterminated block comment – skip rest
						break;
					}
					// Preserve newlines to keep line numbers stable
					const skipped = chars.slice(i, endIdx + syntax.blockEnd.length);
					const newlines = (skipped.match(/\n/g) || []).length;
					result += "\n".repeat(newlines);
					i = endIdx + syntax.blockEnd.length;
					continue;
				}

				// Line comment
				if (syntax.line && chars.startsWith(syntax.line, i)) {
					// Check it's not inside a URL (e.g. http://)
					if (syntax.line === "//" && i > 0 && chars[i - 1] === ":") {
						result += chars[i];
						i++;
						continue;
					}
					const eol = chars.indexOf("\n", i);
					if (eol === -1) {
						break;
					}
					result += "\n";
					i = eol + 1;
					continue;
				}
			}

			// Inside regular string
			if (inString) {
				if (chars[i] === "\\" && i + 1 < len) {
					result += chars[i] + chars[i + 1];
					i += 2;
					continue;
				}
				if (chars[i] === stringChar) {
					inString = false;
				}
				result += chars[i];
				i++;
				continue;
			}

			// Inside template string
			if (inTemplateString) {
				if (chars[i] === "\\" && i + 1 < len) {
					result += chars[i] + chars[i + 1];
					i += 2;
					continue;
				}
				if (chars[i] === "`") {
					templateDepth--;
					if (templateDepth === 0) {
						inTemplateString = false;
					}
				}
				result += chars[i];
				i++;
				continue;
			}

			result += chars[i];
			i++;
		}

		return this._cleanEmptyLines(result);
	}

	/**
	 * @param {string} content
	 * @param {{ blockStart: string, blockEnd: string }} syntax
	 * @returns {string}
	 */
	_stripHtmlComments(content, syntax) {
		let result = "";
		let i = 0;

		while (i < content.length) {
			if (content.startsWith(syntax.blockStart, i)) {
				const endIdx = content.indexOf(
					syntax.blockEnd,
					i + syntax.blockStart.length,
				);
				if (endIdx === -1) {
					break;
				}
				const skipped = content.slice(i, endIdx + syntax.blockEnd.length);
				const newlines = (skipped.match(/\n/g) || []).length;
				result += "\n".repeat(newlines);
				i = endIdx + syntax.blockEnd.length;
				continue;
			}
			result += content[i];
			i++;
		}

		return this._cleanEmptyLines(result);
	}

	/**
	 * Remove excessive blank lines (3+ consecutive → 2)
	 * @param {string} text
	 * @returns {string}
	 */
	_cleanEmptyLines(text) {
		return text.replace(/\n{3,}/g, "\n\n");
	}
}

module.exports = { CommentStripper };
