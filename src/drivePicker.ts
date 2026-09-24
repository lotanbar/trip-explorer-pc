/**
 * Google Drive setup, over the whole window: sign in (in the browser), then pick the Drive folder the
 * trips folder syncs with. The folder list starts at My Drive; a folder opens with a click, Up goes
 * back, New folder makes one here. My Drive itself cannot be picked.
 */

import { driveCreateFolder, driveListFolders, drivePickFolder, driveSignIn, driveSignOut, type DriveFolder, type SyncStatus } from './backend';
import { ask } from './dialog';

export async function openDriveSetup(status: SyncStatus): Promise<void> {
  if (!status.configured) {
    await ask('This build has no Google client, so Drive sync is off.', [{ label: 'OK', value: null, primary: true }], null);
    return;
  }
  let email = status.email;
  if (!status.signed_in) {
    email = await signIn();
    if (!email) return;
  }
  await pickFolder(email ?? '', status.folder);
}

async function signIn(): Promise<string | null> {
  const backdrop = modal(`<p class="message">Sign in with Google in the browser window that opens. Trip Explorer asks for access to your Drive to keep the trips folder in sync.</p><p class="message muted" id="drive-wait"></p><div class="actions"><button id="drive-cancel">Cancel</button></div>`);
  const wait = backdrop.querySelector<HTMLElement>('#drive-wait')!;
  wait.textContent = 'Waiting for the browser…';
  let cancelled = false;
  backdrop.querySelector('#drive-cancel')!.addEventListener('click', () => {
    cancelled = true;
    backdrop.remove();
  });
  try {
    const email = await driveSignIn();
    backdrop.remove();
    return cancelled ? null : email;
  } catch (e) {
    if (!cancelled) {
      backdrop.remove();
      await ask(`Sign-in failed: ${e}`, [{ label: 'OK', value: null, primary: true }], null);
    }
    return null;
  }
}

function pickFolder(email: string, current: string | null): Promise<void> {
  return new Promise((resolve) => {
    const backdrop = modal(`
      <div class="drive-picker">
        <p class="message">Pick the Google Drive folder that the trips folder stays in sync with.</p>
        <div class="drive-account muted"></div>
        <div class="drive-crumbs"></div>
        <div class="drive-list"></div>
        <div class="drive-new" hidden><input type="text" placeholder="New folder name"><button class="make">Create</button></div>
        <div class="actions">
          <button class="signout">Sign out</button>
          <span class="spacer"></span>
          <button class="newfolder">New folder</button>
          <button class="cancel">Cancel</button>
          <button class="primary pick">Sync with this folder</button>
        </div>
      </div>`);
    const $ = <T extends HTMLElement>(sel: string) => backdrop.querySelector<T>(sel)!;
    $('.drive-account').textContent = `${email}${current ? ` · now syncing with “${current}”` : ''}`;
    const stack: DriveFolder[] = [{ id: 'root', name: 'My Drive' }];
    const here = () => stack[stack.length - 1];
    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve();
    };
    const onKey = (e: KeyboardEvent) => {
      const top = [...document.querySelectorAll('.dialog-backdrop')].pop();
      if (e.key === 'Escape' && top === backdrop) {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', onKey, true);

    async function show(): Promise<void> {
      const crumbs = $('.drive-crumbs');
      crumbs.innerHTML = '';
      stack.forEach((f, i) => {
        const b = document.createElement('button');
        b.className = 'crumb';
        b.textContent = f.name;
        b.disabled = i === stack.length - 1;
        b.addEventListener('click', () => {
          stack.splice(i + 1);
          void show();
        });
        if (i > 0) crumbs.append(' / ');
        crumbs.append(b);
      });
      $<HTMLButtonElement>('.pick').disabled = stack.length === 1;
      const list = $('.drive-list');
      list.innerHTML = '<div class="muted">Loading…</div>';
      try {
        const folders = await driveListFolders(here().id);
        list.innerHTML = '';
        if (!folders.length) list.innerHTML = '<div class="muted">No folders here</div>';
        for (const f of folders) {
          const row = document.createElement('button');
          row.className = 'drive-folder';
          row.textContent = f.name;
          row.addEventListener('click', () => {
            stack.push(f);
            void show();
          });
          list.appendChild(row);
        }
      } catch (e) {
        list.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'status error';
        err.textContent = String(e);
        list.appendChild(err);
      }
    }

    $('.cancel').addEventListener('click', close);
    $('.signout').addEventListener('click', () => {
      void driveSignOut();
      close();
    });
    $('.newfolder').addEventListener('click', () => {
      $('.drive-new').hidden = false;
      $<HTMLInputElement>('.drive-new input').focus();
    });
    const make = async () => {
      const input = $<HTMLInputElement>('.drive-new input');
      const name = input.value.trim();
      if (!name) return;
      try {
        const f = await driveCreateFolder(here().id, name);
        input.value = '';
        $('.drive-new').hidden = true;
        stack.push(f);
        void show();
      } catch (e) {
        await ask(`Could not create the folder: ${e}`, [{ label: 'OK', value: null, primary: true }], null);
      }
    };
    $('.make').addEventListener('click', () => void make());
    $<HTMLInputElement>('.drive-new input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void make();
    });
    $('.pick').addEventListener('click', async () => {
      const f = here();
      const ok = await ask(
        `Keep the trips folder in sync with “${f.name}” on Google Drive? Both are merged: files on only one side are copied to the other, and where both have a file the newer one is kept.`,
        [{ label: 'Cancel', value: false }, { label: 'Sync', value: true, primary: true }],
        false,
      );
      if (!ok) return;
      await drivePickFolder(f.id, f.name);
      close();
    });
    void show();
  });
}

function modal(inner: string): HTMLElement {
  const backdrop = document.createElement('div');
  backdrop.className = 'dialog-backdrop';
  backdrop.innerHTML = `<div class="dialog wide" role="dialog">${inner}</div>`;
  document.body.appendChild(backdrop);
  return backdrop;
}
