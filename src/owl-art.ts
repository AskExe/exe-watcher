// The Watcher owl (01A "folded wings", assets/owls/refined_tucked.svg) as terminal pixel art.
// Generated from the logo's own vector paths: rendered at 8x, sampled to a 25x36 pixel grid,
// two pixel rows per terminal row using half blocks (█ ▀ ▄). Frames share one size so the
// animation never shifts the layout. Centered contrast dots become one pixel at this size.

export type OwlPose = 'center' | 'left' | 'right' | 'blink'

export const OWL_FRAMES: Record<OwlPose, string[]> = {
  center: [
    ' ▄                      ▄',
    ' ███▄                ▄███',
    ' █████▄▄▄▄▄████▄▄▄▄▄█████',
    '  ██████████████████████ ',
    '  ███▀    ▀████▀    ▀███ ',
    '  ██   ▄█▄  ██  ▄█▄   ██ ',
    '  ██   █▄█  ██  █▄█   ██ ',
    '  ███   ▀  ▄██▄  ▀   ███ ',
    '   ████▄▄▄██████▄▄▄████  ',
    '    ▀███████▄▄███████▀   ',
    '     ████████████████    ',
    '    ██████████████████   ',
    '    █ ▀████████████▀ █   ',
    '    ██ ▀██████████▀ ██   ',
    '    ▀██▄██████████▄██▀   ',
    '     ▀▀████████████▀▀    ',
    '      ▄████▀▀▀▀████▄     ',
    '        ▀        ▀       ',
  ],
  left: [
    ' ▄                      ▄',
    ' ███▄                ▄███',
    ' █████▄▄▄▄▄████▄▄▄▄▄█████',
    '  ██████████████████████ ',
    '  ███▀    ▀████▀    ▀███ ',
    '  ██ ▄█▄    ████▄     ██ ',
    '  ██ █▄█    ███▄█     ██ ',
    '  ███ ▀    ▄███▀     ███ ',
    '   ████▄▄▄██████▄▄▄████  ',
    '    ▀███████▄▄███████▀   ',
    '     ████████████████    ',
    '    ██████████████████   ',
    '    █ ▀████████████▀ █   ',
    '    ██ ▀██████████▀ ██   ',
    '    ▀██▄██████████▄██▀   ',
    '     ▀▀████████████▀▀    ',
    '      ▄████▀▀▀▀████▄     ',
    '        ▀        ▀       ',
  ],
  right: [
    ' ▄                      ▄',
    ' ███▄                ▄███',
    ' █████▄▄▄▄▄████▄▄▄▄▄█████',
    '  ██████████████████████ ',
    '  ███▀    ▀████▀    ▀███ ',
    '  ██     ▄████    ▄█▄ ██ ',
    '  ██     █▄███    █▄█ ██ ',
    '  ███     ▀███▄    ▀ ███ ',
    '   ████▄▄▄██████▄▄▄████  ',
    '    ▀███████▄▄███████▀   ',
    '     ████████████████    ',
    '    ██████████████████   ',
    '    █ ▀████████████▀ █   ',
    '    ██ ▀██████████▀ ██   ',
    '    ▀██▄██████████▄██▀   ',
    '     ▀▀████████████▀▀    ',
    '      ▄████▀▀▀▀████▄     ',
    '        ▀        ▀       ',
  ],
  blink: [
    ' ▄                      ▄',
    ' ███▄                ▄███',
    ' █████▄▄▄▄▄████▄▄▄▄▄█████',
    '  ██████████████████████ ',
    '  ██████████████████████ ',
    '  ██████████████████████ ',
    '  ██▄▄▄▄▄▄▄▄██▄▄▄▄▄▄▄▄██ ',
    '  ██████████████████████ ',
    '   ████████████████████  ',
    '    ▀███████▄▄███████▀   ',
    '     ████████████████    ',
    '    ██████████████████   ',
    '    █ ▀████████████▀ █   ',
    '    ██ ▀██████████▀ ██   ',
    '    ▀██▄██████████▄██▀   ',
    '     ▀▀████████████▀▀    ',
    '      ▄████▀▀▀▀████▄     ',
    '        ▀        ▀       ',
  ],
}

// One look-around loop for the loading screen (one pose per 400 ms tick): look ahead, glance
// left, back, glance right, back, blink.
export const OWL_LOOK: OwlPose[] = ['center', 'center', 'left', 'left', 'center', 'right', 'right', 'center', 'blink', 'center']

export function owlFrame(tick: number): string[] {
  const i = ((Math.floor(tick) % OWL_LOOK.length) + OWL_LOOK.length) % OWL_LOOK.length
  return OWL_FRAMES[OWL_LOOK[i]!]
}
