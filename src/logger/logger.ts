import chalk from "chalk";

type LogArgs = readonly unknown[];

function format(args: LogArgs): string {
  return args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2))).join(" ");
}

export const logger = {
  info: (...args: LogArgs) => {
    // Blue for info
    // eslint-disable-next-line no-console
    console.log(chalk.blue(format(args)));
  },
  success: (...args: LogArgs) => {
    // Green for success
    // eslint-disable-next-line no-console
    console.log(chalk.green(format(args)));
  },
  warn: (...args: LogArgs) => {
    // Yellow for warnings
    // eslint-disable-next-line no-console
    console.warn(chalk.yellow(format(args)));
  },
  error: (...args: LogArgs) => {
    // Red for errors
    // eslint-disable-next-line no-console
    console.error(chalk.red(format(args)));
  }
};

