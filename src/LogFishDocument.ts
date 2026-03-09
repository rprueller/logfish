import * as vscode from 'vscode';

export class LogFishDocument implements vscode.CustomDocument {
  readonly uri: vscode.Uri;
  private readonly _onDidDispose = new vscode.EventEmitter<void>();
  readonly onDidDispose = this._onDidDispose.event;

  constructor(uri: vscode.Uri) {
    this.uri = uri;
  }

  dispose(): void {
    this._onDidDispose.fire();
    this._onDidDispose.dispose();
  }
}
