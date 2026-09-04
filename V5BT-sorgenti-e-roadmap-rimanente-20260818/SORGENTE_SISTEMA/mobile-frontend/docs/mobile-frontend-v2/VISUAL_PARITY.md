# Visual Parity

## Goal

The mobile frontend must remain visually close to the original mobile UI while the implementation is modernized.

## Current Parity Anchors

The following original assets are authorized and should be preserved unless a deliberate replacement is documented:

- `home.png`
- `menu.png`
- `bookings.png`
- `notifications.png`
- `settings.png`
- `stats.png`
- `profile.png`
- `logout.png`
- `brokenglass.png`
- `table.svg`

Core shell elements must keep parity:

- system row;
- top bar;
- bottom navigation;
- five mobile tabs: Home, Menu, Tavoli, Agenda/Prenotazioni, Statistiche.

## CSS Policy

Existing global CSS and legacy override files remain visual debt. They may be used to avoid parity regressions, but they must not become the default implementation strategy for new behavior.

Every significant visual refactor must check:

- desktop and mobile viewport layout;
- bottom bar spacing;
- top bar spacing;
- modal readability;
- no overlapping text or controls;
- no loss of original iconography.
