# What's Out There?

A simple static web page that uses your iPhone/iPad's compass and GPS to trace
where you're pointing out to sea and list the next few countries you'd reach —
the seas in between and the nearest city to each landfall included.

**No backend.** Everything — geolocation, compass heading, and the
land-crossing calculation — runs client-side in the browser. It's plain
HTML/CSS/JS, so it can be hosted directly on GitHub Pages with zero build
step.

## How it works

1. On tapping **"Enable Compass & Location"**, the page requests:
   - Compass heading via `DeviceOrientationEvent` (on iOS this requires
     `DeviceOrientationEvent.requestPermission()`, triggered by the button
     tap).
   - Your GPS position via the Geolocation API.
2. A fixed aiming line points up (the direction the top of your device
   faces) while the compass rose rotates so **N** always points to magnetic
   north — so you can orient the device toward the sea. The results then
   **update live** as your heading changes (throttled, and only when the
   heading or position actually moves).
3. For the current heading the app walks a point outward from your
   location along a great-circle path in that direction, in 12 km steps
   (each coastline crossing refined with a bisection search), up to
   20,000 km.
4. Each candidate point is tested against a bundled, simplified world land
   dataset (`data/countries.geojson`, derived from [Natural Earth](https://www.naturalearthdata.com/)
   1:110m admin-0 countries) with a point-in-polygon (ray casting) test.
   The page records the ordered sequence of crossings and reports the next
   **three countries** along the heading (the one you're standing on counts
   as the first).
5. Each stretch of sea between countries is named by testing its midpoint
   against Natural Earth's marine polygons (`data/marine.geojson`), and the
   nearest city to each landfall is found from a bundled populated-places
   list (`data/cities.json`).

## Limitations

- Requires a device with a magnetometer/compass — mostly iPhones and iPads
  in Safari. Most desktops and many Android browsers don't expose a usable
  compass heading.
- Heading is relative to **magnetic** north, not true north, and can be
  thrown off by nearby metal/magnets.
- The coastline data is simplified (110m resolution), so small islands or
  narrow spits of land can be missed.
- Countries are sovereign states, so the UK is reported as "United Kingdom"
  rather than "England", France includes overseas boundaries, and so on.
- It's a straight great-circle line, so it will "hit" any land the path
  crosses, not necessarily the closest point of a country's coastline.

## Running locally

Just serve the directory with any static file server, e.g.:

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Note: geolocation and device orientation
both require a secure context, so for anything other than `localhost` you'll
need HTTPS (which GitHub Pages provides automatically).

## Deploying to GitHub Pages

Enable GitHub Pages for this repository (Settings → Pages), serving from the
branch/folder containing these files (root). No build step is required.
