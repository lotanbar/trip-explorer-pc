/**
 * A small in-app question box over the whole window. Resolves with the pressed button's value, or
 * with `cancel` on Escape or a click outside. A button with `delay` stays disabled for that many
 * seconds, counting down on its label, so it cannot be pressed by accident.
 */

export interface DialogButton<T> {
  label: string;
  value: T;
  primary?: boolean;
  delay?: number;
}

export function ask<T>(message: string, buttons: DialogButton<T>[], cancel: T): Promise<T> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'dialog-backdrop';
    backdrop.innerHTML = `<div class="dialog" role="dialog"><p class="message"></p><div class="actions"></div></div>`;
    backdrop.querySelector('.message')!.textContent = message;
    const row = backdrop.querySelector('.actions')!;
    const timers: number[] = [];

    const done = (value: T) => {
      timers.forEach((t) => window.clearInterval(t));
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      done(cancel);
    };

    for (const b of buttons) {
      const button = document.createElement('button');
      if (b.primary) button.className = 'primary';
      button.addEventListener('click', () => done(b.value));
      let left = b.delay ?? 0;
      const label = () => { button.textContent = left > 0 ? `${b.label} (${left})` : b.label; };
      button.disabled = left > 0;
      label();
      if (left > 0) {
        const t = window.setInterval(() => {
          left -= 1;
          label();
          if (left <= 0) {
            button.disabled = false;
            window.clearInterval(t);
          }
        }, 1000);
        timers.push(t);
      }
      row.appendChild(button);
    }

    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(cancel); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(backdrop);
    row.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  });
}
