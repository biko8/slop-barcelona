# Slop Barcelona

Barcelona en 3D con [three.js](https://threejs.org/), WebGPURenderer y TSL, a escala real: el Eixample de Cerdà con sus illes achaflanadas y sus patios interiores, Ciutat Vella, Gràcia, Sants, el Poblenou y el frente marítimo, con la Sagrada Família, la Pedrera, la Casa Batlló, la Torre Glòries y compañía. Recórrela a pie, en taxi, en bici o en helicóptero.

Es un remix de [Slop New York](https://github.com/mrdoob/slop-newyork/): el mismo motor (tráfico, peatones, iluminación, materiales TSL, cámaras, audio) alimentado con la geografía real de Barcelona.

## Ejecutarlo

Es una web estática: sírvela con cualquier servidor (por ejemplo `python3 -m http.server`) y abre `index.html` en un navegador con WebGPU.

## Los datos

Toda la ciudad sale de OpenStreetMap, convertida al marco del mundo: 1 unidad = 1 m, el eje x a lo largo de la cuadrícula del Eixample hacia el Besòs, el z hacia el mar, con el origen en el centro de la Plaça de Catalunya y los ejes girados ~45° como la propia cuadrícula.

1. `tools/bcn-extract.py` extrae de un `.osm.pbf` (por ejemplo el de [BBBike](https://download.bbbike.org/osm/bbbike/Barcelona/)) las capas que hacen falta a `tools/data/bcn_*.json`: calles, línea de costa, parques, playas y plazas, edificios (con plantas, altura y orientación), monumentos y mobiliario (semáforos, bocas de metro, Bicing, fuentes). Necesita `pip install osmium`.

   ```sh
   python3 tools/bcn-extract.py Barcelona.osm.pbf
   ```

2. `tools/build-bcn-geodata.mjs` genera `js/bcn-geodata.js` (la ciudad detallada: tierra y mar, manzanas con sus solares e illes, grafo viario, parques, monumentos, mobiliario) y `js/bcn-metro.js` (los edificios del área metropolitana alrededor).

   ```sh
   node --max-old-space-size=8192 tools/build-bcn-geodata.mjs
   ```

Las manzanas se obtienen rasterizando cada calle a su anchura real sobre la tierra, recortando los chaflanes de Cerdà en los cruces de la cuadrícula y etiquetando lo que queda; `js/buildings.js` levanta en cada illa del Eixample sus casas alrededor del patio, un edificio mirando a cada chaflán, y en el casco antiguo casas estrechas a lo largo de las calles, con las alturas que OpenStreetMap da a cada manzana.

## Tests

```sh
node --test tests/*.test.cjs tests/*.test.mjs
```

## Licencia y datos

El código está bajo la [licencia MIT](LICENSE).

Datos geográficos: © [colaboradores de OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL). Los datos y dependencias de terceros mantienen sus licencias.
