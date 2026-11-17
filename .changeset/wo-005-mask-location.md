---
"@bug-free-eureka/core": patch
---

Keep safe `file:line` evidence locations unmasked in findings and reports, and only mask short key names (`auth`, `otp`, `code`, `sig`, `session`, `pwd`) when they appear as whole words, so text such as `design`, `signal` or `author` is no longer masked.
