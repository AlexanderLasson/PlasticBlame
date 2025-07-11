import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';

let currentDecoration: vscode.TextEditorDecorationType | null = null;

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('plasticBlame.showBlame', () => {
    const editor = vscode.window.activeTextEditor;
	vscode.window.onDidChangeTextEditorSelection(e => {
		vscode.commands.executeCommand('plasticBlame.showBlame');
	});
    if (!editor) {
      vscode.window.showInformationMessage('No active editor');
      return;
    }

    const filePath = editor.document.uri.fsPath;
    const cursorLine = editor.selection.active.line + 1;

    // Here we run Plastic SCM annotate command
    exec(`cm annotate "${filePath}"`, (err, stdout, stderr) => {
      if (err || stderr) {
        vscode.window.showErrorMessage(`Plastic annotate failed: ${stderr || err?.message}`);
        return;
      }

      const lines = stdout.split('\n');
      if (cursorLine > lines.length) {
		return;
	  }

      const targetLine = lines[cursorLine - 1].trim();
	  const parts = targetLine.split('');
	  const author = parts[0];
	  const blameText = `${author} • ${parts[1]}`;

      // Clear existing decorations
      if (currentDecoration) {
        editor.setDecorations(currentDecoration, []);
        currentDecoration.dispose();
      }

      currentDecoration = vscode.window.createTextEditorDecorationType({
        after: {
          contentText: blameText,
          color: '#999999',
          margin: '0 0 0 20px'
        },
        isWholeLine: true
      });

      const range = new vscode.Range(cursorLine - 1, 0, cursorLine - 1, 0);
      editor.setDecorations(currentDecoration, [{ range }]);
    });
  });

  context.subscriptions.push(disposable);
}
