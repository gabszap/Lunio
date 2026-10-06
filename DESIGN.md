---

name: Lunio
description: Cinematic dark media player focused on immersive and comfortable video playback
colors:
primary: "#A78BFA"
primary-strong: "#7C3AED"
secondary: "#38BDF8"
background: "#080A0F"
surface: "#171B24"
surface-elevated: "#1E2430"
on-background: "#F4F7FA"
on-surface: "#F4F7FA"
on-surface-secondary: "#9BA4B2"
on-surface-disabled: "#5D6675"
success: "#4ADE80"
warning: "#FBBF24"
error: "#FB7185"
typography:
body-md:
fontFamily: Inter
fontSize: 16px
fontWeight: 400
body-sm:
fontFamily: Inter
fontSize: 14px
fontWeight: 400
title-lg:
fontFamily: Inter
fontSize: 24px
fontWeight: 600
title-xl:
fontFamily: Inter
fontSize: 32px
fontWeight: 700
label-md:
fontFamily: Inter
fontSize: 14px
fontWeight: 500
rounded:
sm: 6px
md: 10px
lg: 14px
xl: 18px
--------

# Lunio Design System

## Product Identity

Lunio is a modern media player focused on watching video content with a clean, immersive and comfortable experience.

The product should feel like a dedicated media application, not a generic website, SaaS dashboard, or streaming landing page.

Core characteristics:

* Media-first
* Cinematic
* Dark
* Minimal
* Calm
* Modern
* Professional
* Immersive

The interface should remain visually quiet so the content stays the primary focus.

The brand can subtly evoke night, moonlight and media without becoming a literal moon-themed application.

---

## Design Philosophy

The central principle is:

> The interface should disappear when the content starts.

Lunio should feel closer to a professional desktop media player or modern TV interface than a conventional web application.

Design priorities:

1. Video and media content
2. Player controls
3. Navigation clarity
4. Visual hierarchy
5. Comfortable long-session usage
6. Consistent interactions
7. Branding
8. Decoration

Avoid visual elements that exist purely for decoration.

---

## Visual Personality

Lunio should feel:

* sophisticated
* quiet
* atmospheric
* cinematic
* slightly futuristic
* approachable
* premium without feeling luxurious

The visual language should be subtle rather than flashy.

Do not make Lunio look like:

* an admin dashboard
* a productivity application
* a generic SaaS template
* a social network
* a meditation application
* a neon gaming interface
* a conventional streaming-service clone

---

## Color Direction

The interface is dark-first.

The majority of the UI should use dark blue-black and graphite surfaces.

Primary background:

`#080A0F`

Secondary background:

`#10131A`

Surface:

`#171B24`

Elevated surface:

`#1E2430`

Text should use soft white rather than pure white:

`#F4F7FA`

Secondary text:

`#9BA4B2`

Disabled text:

`#5D6675`

### Brand Accent

The primary Lunio accent is a soft lunar violet:

`#A78BFA`

Use it for:

* active states
* playback progress
* selected items
* primary actions
* focus states
* branding

The stronger violet:

`#7C3AED`

should be reserved for stronger interactive states.

The interface should not become overwhelmingly purple. Most of the UI remains neutral and dark.

### Secondary Accent

Use:

`#38BDF8`

as a subtle cool-blue secondary accent.

The combination of violet and blue should evoke subtle night lighting.

---

## Brand Gradient

A subtle lunar gradient may be used for logos and small brand accents:

`#A78BFA → #7C3AED → #38BDF8`

Do not use large gradients as application backgrounds.

Avoid the common generic SaaS aesthetic of covering the entire interface in purple gradients.

---

## Logo Direction

The Lunio logo should be minimal and recognizable at small sizes.

The logo must work as:

* application logo
* header mark
* favicon
* browser icon
* mobile icon
* loading mark

Explore these concepts:

### Lunar L

A geometric `L` combined subtly with a crescent or orbital shape.

### Lunar Play

A minimal crescent or circular shape incorporating a play symbol.

### Orbital Play

An abstract circular/orbital symbol communicating both night and media playback.

### Abstract L

A custom geometric `L` that does not literally depict a moon.

The symbol should work independently from the wordmark.

Preferred wordmark:

**lunio**

Use lowercase typography with a clean, geometric appearance.

Avoid:

* literal moon illustrations
* excessive stars
* mascots
* cartoon aesthetics
* generic play buttons
* overly complex symbols

---

## Typography

Use a modern sans-serif typeface.

Inter is the preferred default.

Typography should prioritize:

* readability
* clean hierarchy
* comfortable viewing
* compact media metadata

Use stronger weights for titles and medium weights for controls.

Avoid decorative or futuristic display fonts.

---

## Layout

Use generous negative space.

The interface should feel intentional rather than densely packed.

Prioritize:

* large media areas
* strong alignment
* consistent spacing
* clear hierarchy

Avoid:

* excessive containers
* unnecessary cards
* dense grids
* huge decorative hero sections
* excessive borders

---

## Navigation

Navigation should remain compact and secondary to the media.

The header should not dominate the screen.

Use:

* dark surfaces
* subtle contrast
* clear active states
* minimal iconography
* concise labels

The user should immediately understand:

* where they are
* what is playing
* how to return
* where settings are

---

## Player

The player is the most important component in Lunio.

It should dominate the visual hierarchy.

The player should feel like a professional desktop media player or modern TV interface.

Existing functionality should be preserved.

Relevant controls may include:

* Play / Pause
* Seek
* Progress
* Volume
* Fullscreen
* Audio selection
* Subtitle selection
* Settings

Controls should have:

* clear hierarchy
* comfortable hit areas
* subtle backgrounds
* smooth transitions
* obvious active states

---

## Player Behavior

Controls should not permanently dominate the video.

When the user is inactive:

* controls fade out
* overlays become less prominent
* unnecessary UI disappears

When the user interacts:

* controls return smoothly
* active states become visible

The content should remain unobstructed.

---

## Progress Bar

The playback timeline is a major visual element.

Use:

* dark neutral track
* Lunio violet for played progress
* subtle hover expansion
* clear seek interaction

Track:

`#1E2430`

Progress:

`#A78BFA`

Hover:

`#C4B5FD`

---

## Player Menus

Menus for:

* Audio
* Subtitles
* Quality
* Playback speed
* Settings

should feel like extensions of the player rather than separate pages.

Use dark elevated surfaces and restrained contrast.

Menus should be compact and contextual.

---

## Cards

Cards should only be used when they improve content organization.

Do not turn every piece of content into a floating rounded rectangle.

Cards should be:

* dark
* subtle
* compact
* content-focused

Use elevation and contrast rather than heavy borders.

---

## Border Radius

Use moderate rounding.

Suggested hierarchy:

* Small controls: `6px`
* Buttons and standard components: `10px`
* Cards and menus: `14px`
* Larger surfaces: `18px`

Do not make every component excessively rounded.

Pill-shaped elements should only be used when they have a semantic reason to be pills.

---

## Borders

Use subtle borders primarily for separation.

Preferred border:

`rgba(255,255,255,0.06)`

Do not outline every component.

---

## Shadows

Use soft and restrained shadows.

Dark surfaces should primarily be separated through:

* contrast
* elevation
* spacing

rather than heavy shadows.

---

## Motion

Animations should be subtle and fast.

Preferred:

* opacity transitions
* small transforms
* menu expansion
* control fade
* hover transitions

Avoid:

* excessive motion
* constant animations
* bouncing elements
* decorative particles
* long transitions

The interface should feel fast.

---

## Responsive Design

Lunio must work naturally across:

* desktop
* laptop
* tablet
* mobile

Do not simply shrink the desktop interface.

### Desktop

Prioritize:

* large player
* comfortable controls
* useful secondary media information

### Mobile

Prioritize:

* video
* essential controls
* touch-friendly interaction
* simplified menus
* minimal secondary information

The player remains the primary experience at every breakpoint.

---

## Empty States

Keep empty states minimal.

Use:

* simple iconography
* short text
* subtle Lunio accent
* generous spacing

Avoid giant illustrations or marketing-style messaging.

---

## Loading States

Loading states should be quiet and unobtrusive.

Use:

* subtle spinners
* skeletons when useful
* low-contrast animation

Do not make loading screens visually louder than the application itself.

---

## Accessibility

Maintain:

* strong text contrast
* visible focus states
* keyboard navigation
* accessible control sizes
* meaningful labels
* clear active states

Never rely solely on color to communicate important information.

---

## Iconography

Use a consistent icon set.

Icons should be:

* simple
* geometric
* recognizable
* consistent in stroke weight

Media controls should use familiar conventions whenever possible.

Avoid mixing unrelated icon styles.

---

## Component Consistency

All components should share the same visual language.

This includes:

* buttons
* inputs
* dropdowns
* modals
* menus
* tooltips
* cards
* player controls
* navigation
* notifications
* loading states
* empty states

No component should look like it came from a different design system.

---

## Design Tokens

Keep the design system centralized.

Core tokens:

* `--lunio-bg`
* `--lunio-bg-secondary`
* `--lunio-surface`
* `--lunio-surface-elevated`
* `--lunio-text`
* `--lunio-text-secondary`
* `--lunio-text-disabled`
* `--lunio-accent`
* `--lunio-accent-strong`
* `--lunio-accent-blue`
* `--lunio-success`
* `--lunio-warning`
* `--lunio-error`

Adapt the implementation to the project's existing frontend architecture.

---

## Design Rules

When making visual decisions:

1. Content comes first.
2. The player comes second.
3. Usability comes before decoration.
4. Branding should be recognizable but restrained.
5. Dark surfaces should dominate.
6. Accent colors should guide attention, not fill the screen.
7. Every visual element should have a purpose.
8. Avoid generic SaaS patterns.
9. Avoid unnecessary cards and containers.
10. Preserve the existing functionality.

If a visual element competes with the content, reduce or remove it.

---

## Final Goal

The final interface should immediately communicate:

> **Lunio is a professional media player designed for comfortable, immersive watching.**

The overall feeling should be:

**dark + cinematic + calm + modern + media-focused**

The product should look and feel like a real media application rather than a website template.

The most important principle is:

> **Lunio should stay out of the way of what the user came to watch.**
