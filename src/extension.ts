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

  constructor() {
    this.setupSelectionChangeListener();
  }

  private setupSelectionChangeListener() {
    // We remove existing listener to prevent duplicates
    if (this.selectionChangeListener) {
      this.selectionChangeListener.dispose();
    }

    this.selectionChangeListener = vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor === vscode.window.activeTextEditor && !this.isProcessing) {
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
    const cacheKey = `${filePath}:${lineNumber}`;
    
    // Check cache first
    if (this.blameCache.has(cacheKey)) {
      const cached = this.blameCache.get(cacheKey);
      return cached ? cached[0] : null;
    }

    return new Promise((resolve, reject) => {
      exec(`cm annotate "${filePath}"`, (err, stdout, stderr) => {
        if (err || stderr) {
          console.error(`Plastic annotate failed: ${stderr || err?.message}`);
          resolve(null);
          return;
        }

        try {
          const blameData = this.parseAnnotateOutput(stdout);
          
          // Cache all results for this file
          blameData.forEach((info, index) => {
            const key = `${filePath}:${index + 1}`;
            this.blameCache.set(key, [info]);
          });

          const targetInfo = blameData[lineNumber - 1];
          resolve(targetInfo || null);
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
      
      // Standard Plastic SCM annotate output format: "author branch#changeset"
      const match = line.match(/^([^\s]+)\s+([^#]+#\d+)$/);
      
      if (match) {
        const [, author, changeset] = match;
        blameData.push({
          line: i + 1,
          changeset,
          author,
          date: '' // Plastic SCM doesn't include date in this format :(
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

  private showBlameDecoration(editor: vscode.TextEditor, lineNumber: number, blameInfo: BlameInfo) {
    // Clear existing decorations
    if (this.currentDecoration) {
      editor.setDecorations(this.currentDecoration, []);
      this.currentDecoration.dispose();
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

  context.subscriptions.push(showBlameCommand, clearCacheCommand);
}

export function deactivate() {
  if (blameProvider) {
    blameProvider.dispose();
  }
}
