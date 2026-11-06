# dmgbuild settings for the macOS installer. The layout is not written here:
# scripts/make-dmg.mjs passes scripts/dmg-layout.mjs as JSON (-D layout=…).
# dmgbuild writes the window layout (.DS_Store) itself — no Finder scripting on CI.
import json
import os.path

app = defines['app']
build_dir = defines['build']
layout = json.loads(defines['layout'])
appname = os.path.basename(app)

# LZMA: the smallest of macOS's dmg formats (opens on macOS 10.15 and later; the app needs 11).
format = 'ULMO'
filesystem = 'HFS+'
files = [app] + [os.path.join(build_dir, '..', i['path']) for i in layout['icons'] if i['type'] == 'file']
symlinks = {os.path.basename(i['path']): i['path'] for i in layout['icons'] if i['type'] == 'link'}

background = os.path.join(build_dir, 'background.png')
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
window_rect = ((200, 120), (layout['window']['width'], layout['window']['height']))
default_view = 'icon-view'
icon_size = layout['iconSize']
text_size = 13
icon_locations = {
    (appname if i['type'] == 'app' else os.path.basename(i['path'])): (i['x'], i['y'])
    for i in layout['icons']
}
