import { z } from 'zod';

// The CSP (script-src 'self') forbids eval. zod 4 compiles object parsers with new Function() unless told not to, and
// its check for whether that is allowed already counts as a CSP violation. main.tsx imports this module first, so the
// setting is in place before any schema is created.
z.config({ jitless: true });
