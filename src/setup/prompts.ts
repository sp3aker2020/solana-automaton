import readline from "readline";
import chalk from "chalk";

let rl: readline.Interface | null = null;

function getRL(): readline.Interface {
  if (!rl) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }
  return rl;
}

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    getRL().question(question, (answer) => resolve(answer.trim()));
  });
}

export async function promptRequired(label: string): Promise<string> {
  while (true) {
    const value = await ask(chalk.white(`  → ${label}: `));
    if (value) return value;
    console.log(chalk.yellow("  This field is required."));
  }
}

export async function promptMultiline(label: string): Promise<string> {
  console.log("");
  console.log(chalk.white(`  ${label}`));
  console.log(chalk.dim("  Type your prompt, then press Enter twice to finish:"));
  console.log("");

  const lines: string[] = [];
  let lastWasEmpty = false;

  while (true) {
    const line = await ask("  ");
    if (line === "" && lastWasEmpty && lines.length > 0) {
      // Remove the trailing empty line we added
      lines.pop();
      break;
    }
    if (line === "" && lines.length > 0) {
      lastWasEmpty = true;
      lines.push("");
    } else {
      lastWasEmpty = false;
      lines.push(line);
    }
  }

  const result = lines.join("\n").trim();
  if (!result) {
    console.log(chalk.yellow("  Genesis prompt is required. Try again."));
    return promptMultiline(label);
  }
  return result;
}

export async function promptAddress(label: string): Promise<string> {
  while (true) {
    const value = await ask(chalk.white(`  → ${label}: `));
    if (/^0x[0-9a-fA-F]{40}$/.test(value)) return value;
    console.log(chalk.yellow("  Invalid Ethereum address. Must be 0x followed by 40 hex characters."));
  }
}

export async function promptSolanaAddress(label: string): Promise<string> {
  while (true) {
    const value = await ask(chalk.white(`  → ${label}: `));
    // Base58 check (rough validation)
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return value;
    console.log(chalk.yellow("  Invalid Solana address. Must be a Base58 string (32-44 characters)."));
  }
}

export async function promptConfirm(label: string, defaultValue: boolean = true): Promise<boolean> {
  const suffix = defaultValue ? " (Y/n)" : " (y/N)";
  const value = await ask(chalk.white(`  → ${label}${suffix}: `));
  if (!value) return defaultValue;
  return /^y(es)?$/i.test(value);
}

export async function promptSelect<T extends string>(label: string, options: T[], defaultOption: T): Promise<T> {
  const suffix = ` (${options.join("/")}) [default: ${defaultOption}]`;
  const value = await ask(chalk.white(`  → ${label}${suffix}: `));
  if (!value) return defaultOption;
  const match = options.find(o => o.toLowerCase() === value.toLowerCase());
  if (match) return match;
  console.log(chalk.yellow(`  Invalid option. Please choose from: ${options.join(", ")}`));
  return promptSelect(label, options, defaultOption);
}

export function closePrompts(): void {
  if (rl) {
    rl.close();
    rl = null;
  }
}
