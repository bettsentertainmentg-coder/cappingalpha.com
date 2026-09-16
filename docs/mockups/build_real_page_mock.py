"""Inject variant 18 into the REAL prod game page (saved HTML) so Jack sees it in the actual phone UI.
usage: python3 build_real.py  -> writes real/game_v18.html (served from the scratchpad on :4310)
"""
import json, re, os
here = os.path.dirname(os.path.abspath(__file__))
v = json.load(open(os.path.join(here, 'r4', 'v18.json')))
page = open(os.path.join(here, 'real', 'game.html'), encoding='utf-8').read()
chrome = open(os.path.join(here, 'lab_chrome.html'), encoding='utf-8').read()

# 1. host color contract, re-targeted from .screen / .screen-body.mlb to <html>
start = chrome.index('/* ===== round 3 color contract')
end = chrome.index('/*VARIANT_CSS*/')
contract = chrome[start:end]
contract = contract.replace('.screen-body.mlb{', 'html{').replace('.screen{', 'html{')
contract = contract.replace('.screen.cm-', 'html.cm-').replace('.screen.bm-', 'html.bm-').replace('.screen.w-inset', 'html.w-inset')
contract = re.sub(r'\.screen-body\.nopad[^\n]*\n', '', contract)
contract = re.sub(r'\.toggles[^\n]*\n', '', contract)

# 2. base href so every relative asset and API call resolves to prod
page = page.replace('<meta charset="UTF-8" />', '<meta charset="UTF-8" />\n  <base href="https://cappingalpha.com/">', 1)

# 3. html classes = Jack's toggle choices (tinted text badges, tint chips, edge to edge)
page = re.sub(r'<html([^>]*)>', lambda m: '<html%s class="cm-tint bm-ink w-bleed">' % m.group(1), page, count=1)

# 4. styles: contract + fragment css + section adjustments
inject_css = f"""
<style id="v18-host">
{contract}
{v['css']}
#picks.ca-section {{ padding-left: 0; padding-right: 0; }}
#picks .ca-section-header, #ca-slot-grid, #ca-detail-panel {{ display: none !important; }}
@media (min-width: 901px) {{ #picks .v18 {{ max-width: 720px; margin: 0 auto; }} }}
/* BOTTOM WHEEL: the section tabs ride above the tab bar so a thumb can reach them */
@media (max-width: 900px) {{
  .ca-mobile-tabs {{ position: fixed !important; top: auto !important; bottom: calc(58px + env(safe-area-inset-bottom)); left: 0; right: 0; z-index: 95; border-top: 1px solid var(--border); border-bottom: none; background: var(--bg); box-shadow: 0 1px 0 var(--bg); }}
  html.ca-app .ca-nav-search {{ display: flex !important; }}
  .ca-content {{ padding-bottom: 60px; }}
}}
</style>
"""
page = page.replace('</head>', inject_css + '</head>', 1)

# 5. drop the fragment into the picks section, before the JS-owned grids (kept, hidden, so game-detail.js finds its ids)
sec = re.search(r'(<section id="picks" class="ca-section">)', page)
assert sec, 'picks section not found'
page = page[:sec.end()] + '\n' + v['html'] + '\n' + page[sec.end():]

# 5b. SEARCH BUTTON after the hamburger (Jack 2026-09-16) + wheel gap fix (measure the tab bar)
page = page.replace('<button class="ca-hamburger" aria-label="Menu" onclick="caToggleDrawer()">', '<button class="ca-hamburger" aria-label="Menu" onclick="caToggleDrawer()">', 1)
hb = page.index('<button class="ca-hamburger"'); hb_end = page.index('</button>', hb) + len('</button>')
page = page[:hb_end] + '<button class="ca-hamburger ca-nav-search" aria-label="Search" style="display:flex"><i class="fa-solid fa-magnifying-glass" style="font-size:17px"></i></button>' + page[hb_end:]
page = page.replace('</body>', '<script>(function(){function fit(){var w=document.querySelector(".ca-mobile-tabs"),t=document.querySelector(".ca-tabbar");if(w&&t&&innerWidth<=900){w.style.bottom=t.getBoundingClientRect().height+"px";}}fit();addEventListener("resize",fit);setTimeout(fit,800);})();</script></body>', 1)
# 6. tab and sidebar labels
page = page.replace('data-sec="picks">PICKS</a>', 'data-sec="picks">CAPPERS</a>').replace('data-sec="picks">Picks</a>', 'data-sec="picks">Cappers</a>')

out = os.path.join(here, 'real', 'game_v18.html')
open(out, 'w', encoding='utf-8').write(page)
print('wrote', out, len(page), 'bytes')
