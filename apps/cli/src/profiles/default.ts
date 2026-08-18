import { corePlugin, type Plugin } from '@tiny-harness/core'
import { builtinsPlugin } from '../plugins/builtins.ts'

export const defaultProfile: readonly Plugin[] = [corePlugin, builtinsPlugin]
