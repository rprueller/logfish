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
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'logView.css'));
  const nonce = getNonce();

  // Generate URIs for all module scripts
  const moduleScripts = [
    'utils.js',
    'domElements.js',
    'state.js',
    'highlighting.js',
    'scrolling.js',
    'rendering.js',
    'filtering.js',
    'search.js',
    'eventHandlers.js',
    'logView.js'
  ];

  const scriptUris = moduleScripts.map(script => 
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', script)).toString()
  );

  const templatePath = path.join(extensionUri.fsPath, 'media', 'logView.html');
  const template = fs.readFileSync(templatePath, 'utf8');

  let html = template
    .split('{{NONCE}}').join(nonce)
    .split('{{CSP_SOURCE}}').join(webview.cspSource)
    .split('{{STYLE_URI}}').join(styleUri.toString());

  // Replace script URIs
  for (let i = 0; i < moduleScripts.length; i++) {
    html = html.split(`{{SCRIPT_${i}_URI}}`).join(scriptUris[i]);
  }

  return html;
}
