/**
 * Commander adapter for the `dsc` command line.
 *
 * The launcher parses only what it owns — which profile to boot, extra patch
 * overlays, and the config dumps — and hands everything after its own flags
 * to the booted tree verbatim, where the app plugins parse their own flag
 * families and print their own `--help`. Launcher flags therefore come
 * first: the first token this parser does not recognize starts the inner
 * arguments, so `dsc --profile tui --resume abc` boots the tui profile with
 * `--resume abc`, and `dsc --profile web -h` prints the web app's help.
 * @module @dsc/cli/args
 */
import { Command, CommanderError } from 'commander'

/** The profile booted when none is named. */
export const DEFAULT_PROFILE = 'tui'

/** The profile behind the metacodes-style headless shortcut. */
export const HEADLESS_PROFILE = 'headless'

/** Inner tokens that, first, select the headless profile: `dsc -p "..."`, `dsc -`. */
const HEADLESS_TRIGGERS = new Set(['-p', '--print', '-'])

/**
 * The profile an unnamed invocation boots: headless when the app arguments
 * start with the metacodes print shortcut, otherwise the default.
 */
export function implicitProfile(args: readonly string[]): string {
  return args[0] !== undefined && HEADLESS_TRIGGERS.has(args[0])
    ? HEADLESS_PROFILE
    : DEFAULT_PROFILE
}

export type Invocation =
  | { mode: 'version'; json: boolean }
  | { mode: 'profile'; profile: string; patches: string[]; args: string[] }
  | {
      mode: 'dump-config'
      profile: string
      defaultOnly: boolean
      patches: string[]
    }
  | { mode: 'plugin'; profile: string; args: string[] }

const collect = (value: string, previous: string[] = []): string[] => [
  ...previous,
  value,
]

const HELP_EXAMPLES = `
Examples:
  dsc                                        start the interactive terminal (profile tui)
  dsc --profile web                          boot the web profile (same as: dsc web)
  dsc --web 7777                             serve the browser UI on port 7777 and open it
  dsc serve 7777                             serve the web host on port 7777 without a browser
  dsc -p "run the tests"                     answer one prompt headlessly and exit (profile headless)
  dsc -p "fix it" --json --stream-json       headless with metacodes NDJSON output
  echo "run the tests" | dsc -               read the headless prompt from stdin
  dsc --profile tui --patch ./extra.yml      boot a profile with one extra overlay
  dsc --profile tui --resume <session>       arguments after the launcher flags reach the app
  dsc --profile web --help                   the web app's own flags and help
  dsc plugin --profile tui add <package>     install a plugin into the tui profile
  dsc --profile tui --dump-config            print the composed profile tree
`

interface LauncherOptions {
  profile?: string
  patch?: string[]
  dumpConfig?: boolean
  dumpDefaultConfig?: boolean
}

function resolveBoot(
  program: Command,
  profile: string,
  options: LauncherOptions,
  args: string[],
): Invocation {
  const patches = options.patch ?? []
  if (patches.includes('')) program.error('error: --patch needs a path')
  if (options.dumpConfig !== true && options.dumpDefaultConfig !== true)
    return { mode: 'profile', profile, patches, args }
  if (options.dumpConfig === true && options.dumpDefaultConfig === true)
    program.error(
      'error: --dump-config and --dump-default-config are mutually exclusive',
    )
  if (args.length > 0)
    program.error(
      `error: config dumps take no app arguments, got ${args.map((a) => JSON.stringify(a)).join(' ')}`,
    )
  const defaultOnly = options.dumpDefaultConfig === true
  if (defaultOnly && patches.length > 0)
    program.error(
      'error: --dump-default-config prints the bundle layers and takes no --patch',
    )
  return { mode: 'dump-config', profile, defaultOnly, patches }
}

/** `[7777, ...rest]` becomes `['--port', '7777', ...rest]`; other leading tokens pass through. */
export function withPortFlag(args: readonly string[]): string[] {
  const [first, ...rest] = args
  return first !== undefined && /^\d+$/.test(first)
    ? ['--port', first, ...rest]
    : [...args]
}

/**
 * `dsc --version [--json]` / `dsc -V`: the build identity, before commander
 * sees argv so `--json` selects the JSON document rather than reaching an app.
 */
export function versionInvocation(
  argv: readonly string[],
): Invocation | undefined {
  const [first, ...rest] = argv
  if (first !== '--version' && first !== '-V') return undefined
  if (rest.length === 0) return { mode: 'version', json: false }
  if (rest.length === 1 && rest[0] === '--json')
    return { mode: 'version', json: true }
  return undefined
}

/**
 * Rewrite the metacodes spellings onto launcher commands before parsing:
 * `--web [port]` is `web [--port <port>]` (the browser host).
 */
export function rewriteAliases(argv: readonly string[]): string[] {
  const [first, ...rest] = argv
  if (first === '--web') return ['web', ...withPortFlag(rest)]
  return [...argv]
}

/** Build the launcher program; `resolved` receives the invocation. */
export function buildProgram(
  version: string,
  onResolve: (invocation: Invocation) => void,
): Command {
  const program = new Command()
  program
    .name('dsc')
    .version(
      version,
      '-V, --version',
      'print the version and build identity (--json: one JSON document)',
    )
    .description(
      'dsc: boot a profile — an ordered stack of plugin-bundle patch layers under your own overrides — on the DeepSeek Harness plugin stack.',
    )
    .addHelpText('after', HELP_EXAMPLES)
    .exitOverride()
    .helpOption(false)
    .allowUnknownOption()
    .passThroughOptions()
    .enablePositionalOptions()
    .argument(
      '[args...]',
      "arguments for the booted profile's app (see: dsc --profile <name> --help)",
    )
    .option(
      '--profile <name>',
      `the profile under $DSC_HOME/profiles to boot (default: ${DEFAULT_PROFILE})`,
    )
    .option(
      '--patch <path>',
      'extra patch-list overlay applied after the profile layer (repeatable)',
      collect,
    )
    .option('--dump-config', 'print the composed profile tree and exit')
    .option(
      '--dump-default-config',
      'print the profile tree without its user layer or --patch overlays and exit',
    )
    .action((args: string[], options: LauncherOptions) => {
      if (
        options.profile === undefined &&
        args.some((argument) => argument === '-h' || argument === '--help')
      )
        program.help()
      const profile = options.profile ?? implicitProfile(args)
      if (profile === '') program.error('error: --profile needs a name')
      onResolve(resolveBoot(program, profile, options, args))
    })

  const rejectParentOptions = (command: string): void => {
    const parent = program.opts<LauncherOptions>()
    if (
      parent.profile !== undefined ||
      parent.patch !== undefined ||
      parent.dumpConfig !== undefined ||
      parent.dumpDefaultConfig !== undefined
    )
      program.error(
        `error: ${command} takes none of parent --profile, --patch, --dump-config, or --dump-default-config`,
      )
  }

  const web = program
    .command('web')
    .description(
      "boot the web profile (alias of --profile web); the web app's own flags follow",
    )
  web
    .helpOption(false)
    .allowUnknownOption()
    .passThroughOptions()
    .enablePositionalOptions()
    .argument('[args...]', 'arguments for the web app (see: dsc web --help)')
    .option('--patch <path>', 'extra patch-list overlay (repeatable)', collect)
    .option('--dump-config', 'print the composed web-profile tree and exit')
    .option(
      '--dump-default-config',
      "print the web profile's bundle layers and exit",
    )
    .action((args: string[], options: LauncherOptions) => {
      rejectParentOptions('web')
      onResolve(resolveBoot(web, 'web', options, args))
    })

  const serve = program
    .command('serve')
    .description(
      'serve the web host without opening a browser (alias of: web --no-open [--port <port>]); a leading port number is accepted',
    )
  serve
    .helpOption(false)
    .allowUnknownOption()
    .passThroughOptions()
    .enablePositionalOptions()
    .argument('[args...]', 'an optional port, then arguments for the web app')
    .option('--patch <path>', 'extra patch-list overlay (repeatable)', collect)
    .action((args: string[], options: LauncherOptions) => {
      rejectParentOptions('serve')
      onResolve(
        resolveBoot(serve, 'web', options, [
          '--no-open',
          ...withPortFlag(args),
        ]),
      )
    })

  program
    .command('plugin')
    .description(
      'manage a profile’s plugins by forwarding the remaining arguments to pnpm in the profile directory',
    )
    .requiredOption(
      '--profile <name>',
      'the profile whose plugins to manage (initialized on first use)',
    )
    .allowUnknownOption()
    .argument(
      '[args...]',
      'pnpm arguments, forwarded verbatim (add <pkg>, remove <pkg>, why <pkg>, ...)',
    )
    .action((args: string[], options: { profile: string }) => {
      rejectParentOptions('plugin')
      if (options.profile === '') program.error('error: --profile needs a name')
      if (args.length === 0)
        program.error(
          'error: plugin needs pnpm arguments to forward (e.g. add <package>)',
        )
      onResolve({ mode: 'plugin', profile: options.profile, args })
    })

  return program
}

/**
 * Resolve argv into one invocation, or print and exit for help, version, or
 * a parse error.
 * @param argv - arguments after the Node binary and script.
 * @param version - printed by `--version`.
 * @param exit - process exit, replaceable by tests.
 */
export function parseDscArgs(
  argv: readonly string[],
  version: string,
  exit: (code: number) => never = (code) => process.exit(code),
): Invocation {
  const identity = versionInvocation(argv)
  if (identity !== undefined) return identity
  let resolved: Invocation | undefined
  const program = buildProgram(version, (invocation) => {
    resolved = invocation
  })
  try {
    program.parse(rewriteAliases(argv), { from: 'user' })
  } catch (error) {
    return exit(error instanceof CommanderError ? error.exitCode : 1)
  }
  if (resolved === undefined) throw new Error('dsc: no invocation resolved')
  return resolved
}
