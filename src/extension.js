const vscode = require("vscode");
const {
	AIExportSidebarProvider,
} = require("./providers/ai-export-sidebar-provider");

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	const provider = new AIExportSidebarProvider(context);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider("aiexport.sidebarView", provider),
		vscode.commands.registerCommand("aiexport.refresh", () => {
			void provider.refreshTree({ preserveSelection: true });
		}),
		provider,
	);
}

function deactivate() {}

module.exports = { activate, deactivate };
