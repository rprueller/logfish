import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'logView.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'logView.css'));
  const nonce = getNonce();

  const templatePath = path.join(extensionUri.fsPath, 'media', 'logView.html');
  const template = fs.readFileSync(templatePath, 'utf8');

  return template
    .split('{{NONCE}}').join(nonce)
    .split('{{CSP_SOURCE}}').join(webview.cspSource)
    .split('{{STYLE_URI}}').join(styleUri.toString())
    .split('{{SCRIPT_URI}}').join(scriptUri.toString());
}
