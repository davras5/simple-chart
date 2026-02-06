# Simple Chart

A single-page vanilla JS app for creating **ER diagrams** and **flowcharts** with free-text names — spaces, umlauts, special characters all work out of the box.

Built on top of [Mermaid](https://github.com/mermaid-js/mermaid) (MIT licensed, loaded via CDN).

## Usage

Open `index.html` in a browser. No build step required.

## ER Diagram Syntax

Attributes use a **name-first, comma-separated** format:

```
Name, Type, Key, "Comment"
```

| Column  | Required | Example                        |
|---------|----------|--------------------------------|
| Name    | yes      | `Gebäude ID`                   |
| Type    | yes      | `int`, `string`, `float`, `date` |
| Key     | optional | `PK`, `FK`, `UK`               |
| Comment | optional | `"Büro, Wohnung, Lager"`       |

```
erDiagram
    Gebäude ||--o{ Raum : enthält
    Gebäude {
        Gebäude ID, int, PK
        Gebäude Name, string
        Gebäude Typ, string, , "Büro, Wohnung, Lager"
    }
    Raum {
        Raum ID, int, PK
        Fläche in m², float
    }
```

## Flowchart Syntax

Use quoted strings for free-text node labels. IDs are auto-generated.

```
flowchart TD
    "Antrag einreichen" --> "Dokumente prüfen"
    "Dokumente prüfen" --> {"Unterlagen vollständig?"}
    "Unterlagen vollständig?" -->|"Ja"| "Genehmigung"
    "Unterlagen vollständig?" -->|"Nein"| "Antrag einreichen"
```

## How It Works

1. **Preprocessing** — free-text names are sanitized to valid Mermaid identifiers
2. **Rendering** — sanitized code is passed to Mermaid
3. **Post-processing** — original display names are swapped back into the SVG

## License

MIT
