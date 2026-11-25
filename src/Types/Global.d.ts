/**
 * REDX runtime hooks shared between the Baileys fork and the host bot.
 * The host application sets this flag on Node's global object.
 */
declare global {
  // eslint-disable-next-line no-var
  var __redxGhostActiveFlag: boolean | undefined
}

export {}
