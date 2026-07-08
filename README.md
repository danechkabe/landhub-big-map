# LandHub Big Map

Static GitHub Pages map for active parcels from the `LandMatch Parcels` Notion database.

The site is published at:

https://map.landhub.com.ua/

Data is refreshed from Notion into `data/parcels.json` by a server-side systemd timer every 5 minutes.
GitHub Actions keeps a manual `workflow_dispatch` refresh as a fallback.
