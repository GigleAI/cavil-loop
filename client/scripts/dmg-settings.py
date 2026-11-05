# dmgbuild settings for the macOS installer (scripts/make-dmg.mjs passes the defines).
# dmgbuild writes the window layout (.DS_Store) itself — no Finder scripting on CI.
# Same window as the Electron build's: the app, an Applications link, the
# first-open instructions file, and a background that explains both ways past
# Gatekeeper (no Apple signature in this version).
import os.path

app = defines['app']
here = defines['build']
appname = os.path.basename(app)

# LZMA: the smallest of macOS's dmg formats (opens on macOS 10.15 and later; the app needs 11).
format = 'ULMO'
filesystem = 'HFS+'
files = [app, os.path.join(here, '打不开时看这里.txt')]
symlinks = {'Applications': '/Applications'}

background = os.path.join(here, 'background.png')
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
# Finder sizes the window (title bar included) to these bounds, so only the top
# ~430 px are visible: every icon and label stays above that.
window_rect = ((200, 120), (660, 460))
default_view = 'icon-view'
icon_size = 100
text_size = 13
icon_locations = {
    appname: (180, 120),
    'Applications': (480, 120),
    '打不开时看这里.txt': (330, 368),
}
