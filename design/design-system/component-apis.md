# Design-system component APIs

Extracted from the design project's adherence lint config (`_adherence.oxlintrc.json`).
These are the designer-declared component contracts — the RR7 implementation (issue #115)
should preserve these prop vocabularies where sensible.

| Component | Props | Enums |
|---|---|---|
| Button | variant, size, disabled, fullWidth, onClick, children, style | variant: primary·secondary·ghost·danger; size: sm·md·lg |
| IconButton | variant, size, label, disabled, onClick, children, style | variant: ghost·outline·solid; size: sm·md·lg |
| Badge | tone, children, style | tone: neutral·brand·positive·caution·negative·gold |
| Card | title, action, padding, sunken, children, style | — |
| Tag | selected, onRemove, onClick, children, style | — |
| RatingStars | rating, max, size, showValue, style | — |
| Input | label, hint, error, type, value, defaultValue, placeholder, disabled, onChange, style | — |
| Select | label, options, value, defaultValue, disabled, onChange, style | — |
| Checkbox | label, checked, defaultChecked, disabled, onChange, style | — |
| RadioGroup | label, options, value, defaultValue, disabled, onChange, style | — |
| Switch | label, checked, defaultChecked, disabled, onChange, style | — |
| Tabs | tabs, value, defaultValue, onChange, style | — |
| Dialog | open, title, description, footer, onClose, width, children, style | — |
| Toast | tone, message, detail, onDismiss, style | tone: neutral·positive·negative |
| Tooltip | text, side, children, style | side: top·bottom·left·right |

Adherence rules also ban: raw hex colors (use color tokens), raw px values (use spacing
tokens), and any font other than Space Grotesk / IBM Plex Mono.
