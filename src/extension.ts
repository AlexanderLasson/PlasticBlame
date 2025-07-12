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
  private currentDecoration: vscode.TextEditorDecorationType | null = null;
  private blameCache: Map<string, BlameInfo[]> = new Map();
  private isProcessing = false;
  private selectionChangeListener: vscode.Disposable | null = null;
  private documentChangeListener: vscode.Disposable | null = null;
  private documentCloseListener: vscode.Disposable | null = null;
  private documentSaveListener: vscode.Disposable | null = null;

  constructor() {
    this.setupSelectionChangeListener();
    this.setupDocumentChangeListener();
    this.setupDocumentCloseListener();
    this.setupDocumentSaveListener();
  }

  private setupSelectionChangeListener() {
    if (this.selectionChangeListener) {
      this.selectionChangeListener.dispose();
    }

    this.selectionChangeListener = vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor === vscode.window.activeTextEditor && !this.isProcessing) {
        this.showBlameForCurrentLine();
      }
    });
  }

  private setupDocumentChangeListener() {
    if (this.documentChangeListener) {
      this.documentChangeListener.dispose();
    }

    this.documentChangeListener = vscode.workspace.onDidChangeTextDocument((e) => {
      // Clear cache for the modified document
      const filePath = e.document.uri.fsPath;
      this.clearCacheForFile(filePath);
      
      // If this is the active editor, refresh the blame display
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && activeEditor.document.uri.fsPath === filePath) {
        // Debounce the refresh to avoid too many calls during rapid changes
        setTimeout(() => {
          this.showBlameForCurrentLine();
        }, 100);
      }
    });
  }

  private setupDocumentCloseListener() {
    if (this.documentCloseListener) {
      this.documentCloseListener.dispose();
    }

    this.documentCloseListener = vscode.workspace.onDidCloseTextDocument((document) => {
      // Clear cache when document is closed
      const filePath = document.uri.fsPath;
      this.clearCacheForFile(filePath);
    });
  }

  private setupDocumentSaveListener() {
    if (this.documentSaveListener) {
      this.documentSaveListener.dispose();
    }

    this.documentSaveListener = vscode.workspace.onDidSaveTextDocument((document) => {
      // Clear cache for the saved document
      const filePath = document.uri.fsPath;
      this.clearCacheForFile(filePath);
      // Refresh blame for the current line in the saved document
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && activeEditor.document.uri.fsPath === filePath) {
        this.showBlameForCurrentLine();
      }
    });
  }

  public async showBlameForCurrentLine() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

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
    // Validate line number
    if (lineNumber < 1) {
      return null;
    }

    // Check if we have cached data for this file
    if (this.blameCache.has(filePath)) {
      const cachedData = this.blameCache.get(filePath)!;
      if (lineNumber <= cachedData.length) {
        return cachedData[lineNumber - 1];
      }
    }

    // If not cached or line number out of range, fetch fresh data
    return new Promise((resolve, reject) => {
      exec(`cm annotate "${filePath}"`, (err, stdout, stderr) => {
        if (err || stderr) {
          console.error(`Plastic annotate failed: ${stderr || err?.message}`);
          resolve(null);
          return;
        }

        try {
          const blameData = this.parseAnnotateOutput(stdout);
          
          // Cache the entire blame data for this file
          this.blameCache.set(filePath, blameData);

          // Check if the requested line number is within bounds
          if (lineNumber <= blameData.length) {
            const targetInfo = blameData[lineNumber - 1];
            resolve(targetInfo || null);
          } else {
            // Line number is out of bounds, return null
            resolve(null);
          }
        } catch (parseError) {
          console.error('Error parsing annotate output:', parseError);
          resolve(null);
        }
      });
    });
  }

  private parseAnnotateOutput(output: string): BlameInfo[] {
    const lines = output.split('\n').filter(line => line.trim());
    const blameData: BlameInfo[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Try multiple patterns to match different Plastic SCM output formats
      let match = line.match(/^([^\s]+)\s+([^#]+#\d+)\s*$/);
      
      if (!match) {
        // Try pattern for lines with code: "author branch#changeset content"
        match = line.match(/^([^\s]+)\s+([^#]+#\d+)\s+(.+)$/);
      }
      
      if (!match) {
        // Try pattern for lines with just author and changeset (with optional trailing space)
        match = line.match(/^([^\s]+)\s+([^\s]+)\s*$/);
      }
      
      if (match) {
        const [, author, changeset] = match;
        blameData.push({
          line: i + 1,
          changeset,
          author,
          date: '' // Plastic SCM doesn't include date in this format
        });
      } else {
        // Fallback for lines that don't match the expected format
        blameData.push({
          line: i + 1,
          changeset: 'unknown',
          author: 'unknown',
          date: ''
        });
      }
    }

    return blameData;
  }

  private showBlameDecoration(editor: vscode.TextEditor, lineNumber: number, blameInfo: BlameInfo | null) {
    // Clear existing decorations
    if (this.currentDecoration) {
      editor.setDecorations(this.currentDecoration, []);
      this.currentDecoration.dispose();
    }

    if (!blameInfo) {
      return; // We don't show decoration if no blame info available
    }

    const blameText = `${blameInfo.author} • ${blameInfo.changeset}`;

    this.currentDecoration = vscode.window.createTextEditorDecorationType({
      after: {
        contentText: blameText,
        color: '#999999',
        margin: '0 0 0 20px',
        fontStyle: 'italic'
      },
      isWholeLine: true
    });

    const range = new vscode.Range(lineNumber - 1, 0, lineNumber - 1, 0);
    editor.setDecorations(this.currentDecoration, [{ range }]);
  }

  public clearCacheForFile(filePath: string) {
    this.blameCache.delete(filePath);
  }

  public clearCache() {
    this.blameCache.clear();
  }

  public dispose() {
    if (this.currentDecoration) {
      this.currentDecoration.dispose();
    }
    if (this.selectionChangeListener) {
      this.selectionChangeListener.dispose();
    }
    if (this.documentChangeListener) {
      this.documentChangeListener.dispose();
    }
    if (this.documentCloseListener) {
      this.documentCloseListener.dispose();
    }
    if (this.documentSaveListener) {
      this.documentSaveListener.dispose();
    }
  }
}

let blameProvider: PlasticBlameProvider;

export function activate(context: vscode.ExtensionContext) {
  blameProvider = new PlasticBlameProvider();

  // Register manual blame command
  const showBlameCommand = vscode.commands.registerCommand('plasticBlame.showBlame', () => {
    blameProvider.showBlameForCurrentLine();
  });

  // Register clear cache command
  const clearCacheCommand = vscode.commands.registerCommand('plasticBlame.clearCache', () => {
    blameProvider.clearCache();
    vscode.window.showInformationMessage('Plastic blame cache cleared');
  });

  // Register refresh blame command
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
