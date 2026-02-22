// Arrow-key menu navigation using raw stdin mode. No dependencies.
// Falls back to numbered input if TTY is not available.

import * as readline from 'readline';

const ESC = '\x1B';
const CSI = `${ESC}[`;

function isTTY(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// ---- TTY arrow-key menu ----

function renderSelectOne(options: string[], cursor: number, prompt: string): string {
  let out = `  ${prompt}\n`;
  for (let i = 0; i < options.length; i++) {
    out += i === cursor ? `  > ${options[i]}\n` : `    ${options[i]}\n`;
  }
  return out;
}

function renderSelectMany(options: string[], selected: boolean[], cursor: number, prompt: string): string {
  let out = `  ${prompt}\n`;
  for (let i = 0; i < options.length; i++) {
    const check = selected[i] ? '[x]' : '[ ]';
    const arrow = i === cursor ? '>' : ' ';
    out += `  ${arrow} ${check} ${options[i]}\n`;
  }
  return out;
}

export function selectOne(options: string[], prompt: string, defaultIndex = 0): Promise<number> {
  if (!isTTY()) return selectOneFallback(options, prompt, defaultIndex);

  return new Promise((resolve) => {
    let cursor = defaultIndex;
    const lineCount = options.length + 1;

    const draw = () => {
      // Move up to clear previous render (except first draw)
      process.stdout.write(renderSelectOne(options, cursor, prompt));
    };

    const clear = () => {
      // Move up lineCount lines and clear each
      process.stdout.write(`${CSI}${lineCount}A`);
      for (let i = 0; i < lineCount; i++) {
        process.stdout.write(`${CSI}2K\n`);
      }
      process.stdout.write(`${CSI}${lineCount}A`);
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    draw();

    const onData = (key: string) => {
      if (key === '\r' || key === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        clear();
        process.stdout.write(`  ${prompt} ${options[cursor]}\n`);
        resolve(cursor);
        return;
      }
      if (key === '\x03') { // Ctrl-C
        process.stdin.setRawMode(false);
        process.exit(130);
      }
      if (key === `${ESC}[A` || key === 'k') { // Up
        clear();
        cursor = (cursor - 1 + options.length) % options.length;
        draw();
      } else if (key === `${ESC}[B` || key === 'j') { // Down
        clear();
        cursor = (cursor + 1) % options.length;
        draw();
      }
    };

    process.stdin.on('data', onData);
  });
}

export function selectMany(options: string[], prompt: string, defaults?: boolean[]): Promise<boolean[]> {
  if (!isTTY()) return selectManyFallback(options, prompt, defaults);

  return new Promise((resolve) => {
    let cursor = 0;
    const selected = defaults ? [...defaults] : options.map(() => false);
    const lineCount = options.length + 1;

    const draw = () => {
      process.stdout.write(renderSelectMany(options, selected, cursor, prompt));
    };

    const clear = () => {
      process.stdout.write(`${CSI}${lineCount}A`);
      for (let i = 0; i < lineCount; i++) {
        process.stdout.write(`${CSI}2K\n`);
      }
      process.stdout.write(`${CSI}${lineCount}A`);
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    draw();

    const onData = (key: string) => {
      if (key === '\r' || key === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        clear();
        const chosen = options.filter((_, i) => selected[i]);
        process.stdout.write(`  ${prompt} ${chosen.join(', ') || '(none)'}\n`);
        resolve(selected);
        return;
      }
      if (key === '\x03') {
        process.stdin.setRawMode(false);
        process.exit(130);
      }
      if (key === ' ') { // Space to toggle
        clear();
        selected[cursor] = !selected[cursor];
        draw();
      } else if (key === `${ESC}[A` || key === 'k') {
        clear();
        cursor = (cursor - 1 + options.length) % options.length;
        draw();
      } else if (key === `${ESC}[B` || key === 'j') {
        clear();
        cursor = (cursor + 1) % options.length;
        draw();
      }
    };

    process.stdin.on('data', onData);
  });
}

// ---- Fallback for non-TTY (piped stdin) ----

function question(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function selectOneFallback(options: string[], prompt: string, defaultIndex: number): Promise<number> {
  console.log(`\n  ${prompt}`);
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${i + 1}) ${options[i]}`);
  }
  const answer = await question(`  Choice [${defaultIndex + 1}]: `);
  if (!answer) return defaultIndex;
  const idx = parseInt(answer, 10) - 1;
  return idx >= 0 && idx < options.length ? idx : defaultIndex;
}

async function selectManyFallback(options: string[], prompt: string, defaults?: boolean[]): Promise<boolean[]> {
  console.log(`\n  ${prompt}`);
  for (let i = 0; i < options.length; i++) {
    const d = defaults?.[i] ? '*' : ' ';
    console.log(`  ${i + 1}) [${d}] ${options[i]}`);
  }
  const answer = await question('  Enter numbers (comma-separated): ');
  const selected = defaults ? [...defaults] : options.map(() => false);
  if (answer) {
    // Reset all if user provides input
    selected.fill(false);
    for (const n of answer.split(',')) {
      const idx = parseInt(n.trim(), 10) - 1;
      if (idx >= 0 && idx < options.length) selected[idx] = true;
    }
  }
  return selected;
}

/** Simple text input prompt */
export async function promptInput(prompt: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`  ${prompt}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}
