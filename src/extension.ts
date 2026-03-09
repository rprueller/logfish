import * as vscode from 'vscode';
import { LOGFISH_VIEW_TYPE } from './Types';
import { LogFishProvider } from './LogFishProvider';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(LogFishProvider.register(context));

  context.subscriptions.push(
    vscode.commands.registerCommand('logFish.openLog', async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Open File'
      });
      if (!picked || picked.length === 0) {
        return;
      }

      await vscode.commands.executeCommand('vscode.openWith', picked[0], LOGFISH_VIEW_TYPE);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('logFish.openInViewer', async (uri: vscode.Uri | vscode.Uri[] | undefined) => {
      if (!uri) {
        return;
      }
      const targets = Array.isArray(uri) ? uri : [uri];
      for (const target of targets) {
        await vscode.commands.executeCommand('vscode.openWith', target, LOGFISH_VIEW_TYPE);
      }
    })
  );
}

export function deactivate(): void {
  // Nothing to cleanup.
}
