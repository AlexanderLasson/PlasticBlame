import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';

interface BlameInfo {
  author: string;
  changeset: string;
  date: string;
  line: number;
}

class PlasticBlameProvider {
  // ↓ Debounce timer and single shared decoration type ↓
  private debounceTimer: NodeJS.Timeout | undefined;
  private decorationType: vscode.TextEditorDecorationType;

  private blameCache: Map<string, BlameInfo[]> = new Map();
  private isProcessing = false;
  private selectionChangeListener: vscode.Disposable | null = null;
  private documentChangeListener: vscode.Disposable | null = null;
  private documentCloseListener: vscode.Disposable | null = null;
  private documentSaveListener: vscode.Disposable | null = null;

  constructor() {
    // Create decoration once
    this.decorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      after: {
        margin: '0 0 0 20px',
        color: '#999999',
        fontStyle: 'italic'
      }
    });

    this.setupSelectionChangeListener();
    this.setupDocumentChangeListener();
    this.setupDocumentCloseListener();
    this.setupDocumentSaveListener();
  }

  private setupSelectionChangeListener() {
    this.selectionChangeListener?.dispose();
    this.selectionChangeListener = vscode.window.onDidChangeTextEditorSelection(e => {
      if (e.textEditor === vscode.window.activeTextEditor) {
        clearTimeout(this.debounceTimer!);
        // Only update after 200ms of inactivity
        this.debounceTimer = setTimeout(() => this.showBlameForCurrentLine(), 200);
      }
    });
  }

  private setupDocumentChangeListener() {
    this.documentChangeListener?.dispose();
    this.documentChangeListener = vscode.workspace.onDidChangeTextDocument(e => {
      const filePath = e.document.uri.fsPath;
      this.clearCacheForFile(filePath);
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && activeEditor.document.uri.fsPath === filePath) {
        clearTimeout(this.debounceTimer!);
        this.debounceTimer = setTimeout(() => this.showBlameForCurrentLine(), 200);
      }
    });
  }

  private setupDocumentCloseListener() {
    this.documentCloseListener?.dispose();
    this.documentCloseListener = vscode.workspace.onDidCloseTextDocument(doc => {
      this.clearCacheForFile(doc.uri.fsPath);
    });
  }

  private setupDocumentSaveListener() {
    this.documentSaveListener?.dispose();
    this.documentSaveListener = vscode.workspace.onDidSaveTextDocument(doc => {
      const filePath = doc.uri.fsPath;
      this.clearCacheForFile(filePath);
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && activeEditor.document.uri.fsPath === filePath) {
        this.showBlameForCurrentLine();
      }
    });
  }

  public async showBlameForCurrentLine() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return; }

    const filePath = editor.document.uri.fsPath;
    const cursorLine = editor.selection.active.line + 1;

    try {
      this.isProcessing = true;
      const blameInfo = await this.getBlameInfo(filePath, cursorLine);
      if (blameInfo) {
        this.showBlameDecoration(editor, cursorLine, blameInfo);
      }
    } catch (error) {
      console.error('Error showing blame:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  private async getBlameInfo(filePath: string, lineNumber: number): Promise<BlameInfo | null> {
    if (lineNumber < 1) { return null; }
    if (this.blameCache.has(filePath)) {
      const cached = this.blameCache.get(filePath)!;
      if (lineNumber <= cached.length) {
        return cached[lineNumber - 1];
      }
    }
    return new Promise((resolve, reject) => {
      exec(`cm annotate "${filePath}"`, (err, stdout, stderr) => {
        if (err || stderr) {
          console.error(`Plastic annotate failed: ${stderr || err?.message}`);
          return resolve(null);
        }
        try {
          const data = this.parseAnnotateOutput(stdout);
          this.blameCache.set(filePath, data);
          resolve(lineNumber <= data.length ? data[lineNumber - 1] : null);
        } catch (parseErr) {
          console.error('Error parsing annotate output:', parseErr);
          resolve(null);
        }
      });
    });
  }

private parseAnnotateOutput(output: string): BlameInfo[] {
  const lines = output.split('\n');
  return lines.map((raw, idx) => {
    const trimmed = raw.trim();
    // split on any whitespace:
    const parts = trimmed.split(/\s+/);
    const author    = parts[0] || 'unknown';
    const changeset = parts[1] || 'unknown';
    return {
      line: idx + 1,
      author,
      changeset,
      date: ''  
    };
  });
}



  private showBlameDecoration(editor: vscode.TextEditor, lineNumber: number, blameInfo: BlameInfo | null) {
    if (!blameInfo) { return; }
    const range = new vscode.Range(lineNumber - 1, 0, lineNumber - 1, 0);
    const opts: vscode.DecorationOptions = {
      range,
      renderOptions: { after: { contentText: `${blameInfo.author} • ${blameInfo.changeset}` } }
    };
    editor.setDecorations(this.decorationType, [opts]);
  }

  public clearCacheForFile(filePath: string) {
    this.blameCache.delete(filePath);
  }

  public clearCache() {
    this.blameCache.clear();
  }

  public dispose() {
    this.decorationType.dispose();
    this.selectionChangeListener?.dispose();
    this.documentChangeListener?.dispose();
    this.documentCloseListener?.dispose();
    this.documentSaveListener?.dispose();
  }
}

let blameProvider: PlasticBlameProvider;

export function activate(context: vscode.ExtensionContext) {
  blameProvider = new PlasticBlameProvider();

  const showBlameCommand = vscode.commands.registerCommand('plasticBlame.showBlame', () => {
    blameProvider.showBlameForCurrentLine();
  });

  const clearCacheCommand = vscode.commands.registerCommand('plasticBlame.clearCache', () => {
    blameProvider.clearCache();
    vscode.window.showInformationMessage('Plastic blame cache cleared');
  });

  const refreshBlameCommand = vscode.commands.registerCommand('plasticBlame.refreshBlame', () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const filePath = editor.document.uri.fsPath;
      blameProvider.clearCacheForFile(filePath);
      blameProvider.showBlameForCurrentLine();
      vscode.window.showInformationMessage('Plastic blame refreshed');
    }
  });

  context.subscriptions.push(showBlameCommand, clearCacheCommand, refreshBlameCommand);
}

export function deactivate() {
  if (blameProvider) {
    blameProvider.dispose();
  }
}
