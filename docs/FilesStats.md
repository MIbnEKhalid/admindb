
## File & Folder Structure

[Back To Main](../README.md)


38 directories, 197 files

### Files
```
Repo
│   .gitignore
│   .npmrc
│   CONTRIBUTING.md
│   LICENSE
│   package-lock.json
│   package.json
│   README.md
│   tailwind.config.js
│   tsconfig.json
│   
├───.github
│   └───workflows
│           checkLatestVersion.yml
│
├───docs
│   │   API.md
│   │   EXAMPLES.md
│   │   FilesStats.md
│   │   SECURITY.md
│   │
│   └───screenshots
│           bulk-actions.png
│           databases.png
│           db-info.png
│           designer-table.png
│           designer.png
│           erd.png
│           form.png
│           home.png
│           index.md
│           inline-editing.png
│           inspector.png
│           new-row.png
│           query.png
│           readonly.png
│           schema.png
│           seed-picker.png
│           seed.png
│           table.png
│
├───scripts
│       capture-screenshots.mjs
│       clean-dist.mjs
│       copy-assets.mjs
│       file_doc.cjs
│       generate-hash.mjs
│       publish.js
│
├───src
│   │   app.ts
│   │   cli.ts
│   │   index.ts
│   │   serverless.ts
│   │
│   ├───auth
│   │       config.ts
│   │       crypto.ts
│   │       index.ts
│   │       middleware.ts
│   │       routes.ts
│   │       types.ts
│   │
│   ├───cli
│   │       args.ts
│   │       config.ts
│   │       index.ts
│   │       runner.ts
│   │
│   ├───core
│   │   │   context.ts
│   │   │   errors.ts
│   │   │   index.ts
│   │   │   result.ts
│   │   │   router.ts
│   │   │
│   │   ├───diff
│   │   │       data-differ.ts
│   │   │       patch-generator.ts
│   │   │       schema-differ.ts
│   │   │
│   │   └───transfer
│   │           dialect-mapper.ts
│   │           masking.ts
│   │           sync-engine.ts
│   │           topological-sort.ts
│   │
│   ├───data
│   │       chain.ts
│   │       datasets.ts
│   │       detector.ts
│   │       engine.ts
│   │       index.ts
│   │       prng.ts
│   │       registry.ts
│   │       schema-graph.ts
│   │       strategies.ts
│   │       templates.ts
│   │       types.ts
│   │       validator.ts
│   │
│   ├───db
│   │   │   database.ts
│   │   │   export.ts
│   │   │   filters.ts
│   │   │   index.ts
│   │   │   manager.ts
│   │   │   migrations.ts
│   │   │   postgres.ts
│   │   │   types.ts
│   │   │
│   │   └───dialects
│   │       │   index.ts
│   │       │   types.ts
│   │       │
│   │       ├───postgres
│   │       │       ddl.ts
│   │       │       dialect.ts
│   │       │       introspector.ts
│   │       │       types.ts
│   │       │
│   │       └───sqlite
│   │               ddl.ts
│   │               dialect.ts
│   │               introspector.ts
│   │               types.ts
│   │
│   ├───modules
│   │   │   index.ts
│   │   │
│   │   ├───databases
│   │   │       databases.routes.ts
│   │   │       databases.service.ts
│   │   │       index.ts
│   │   │
│   │   ├───erd
│   │   │       erd.routes.ts
│   │   │       erd.service.ts
│   │   │       index.ts
│   │   │
│   │   ├───query
│   │   │       index.ts
│   │   │       query.routes.ts
│   │   │       query.service.ts
│   │   │
│   │   ├───rows
│   │   │       blob.helper.ts
│   │   │       display.helper.ts
│   │   │       index.ts
│   │   │       rows.routes.ts
│   │   │       rows.service.ts
│   │   │
│   │   ├───schema
│   │   │       index.ts
│   │   │       schema.routes.ts
│   │   │       schema.service.ts
│   │   │
│   │   ├───search
│   │   │       index.ts
│   │   │       search.routes.ts
│   │   │       search.service.ts
│   │   │       search.types.ts
│   │   │
│   │   ├───seed
│   │   │       index.ts
│   │   │       seed.routes.ts
│   │   │       seed.service.ts
│   │   │
│   │   ├───sync
│   │   │       index.ts
│   │   │       sync.routes.ts
│   │   │       sync.service.ts
│   │   │
│   │   └───tables
│   │           index.ts
│   │           tables.routes.ts
│   │           tables.service.ts
│   │
│   ├───public
│   │   ├───css
│   │   │       app.css
│   │   │       input.css
│   │   │
│   │   └───js
│   │           api.js
│   │           app.js
│   │           browse.js
│   │           common.js
│   │           databases.js
│   │           designer.js
│   │           forms.js
│   │           home.js
│   │           inspector.js
│   │           query.js
│   │           schema.js
│   │           search.js
│   │           seed.js
│   │           sync.js
│   │
│   ├───sql
│   │       classifier.ts
│   │       error-analyzer.ts
│   │       generator.ts
│   │       index.ts
│   │
│   ├───types
│   │       api.ts
│   │
│   ├───utils
│   │       colors.ts
│   │       common.ts
│   │       csv.ts
│   │       datatype.ts
│   │       icons.ts
│   │       index.ts
│   │       logger.ts
│   │       stream.ts
│   │
│   └───views
│       ├───layouts
│       │       main.hbs
│       │
│       ├───pages
│       │       databases.hbs
│       │       designer.hbs
│       │       erd.hbs
│       │       error.hbs
│       │       form.hbs
│       │       home.hbs
│       │       info.hbs
│       │       login.hbs
│       │       query.hbs
│       │       schema.hbs
│       │       seed-select.hbs
│       │       seed.hbs
│       │       sync.hbs
│       │       table.hbs
│       │
│       └───partials
│               icon.hbs
│               navbar.hbs
│               sidebar.hbs
│
├───test
│       auth.test.ts
│       chain-seeder.test.ts
│       classifier.test.ts
│       csv.test.ts
│       database.test.ts
│       datatype.test.ts
│       erd.test.ts
│       error-analyzer.test.ts
│       generator.test.ts
│       harness.ts
│       manager.test.ts
│       postgres.test.ts
│       search.test.ts
│       seeder.test.ts
│       serverless.test.ts
│       smoke.test.ts
│       streaming-cursor.test.ts
│       sync.test.ts
│       unified-seed-engine.test.ts
│
└───testapp
        index.html
        package-lock.json
        package.json
        README.md
        seed-data.js
        server.js
```

### Lines of code
node count_lines.cjs
exlcuding node_modules,docs,documenatation,data,package-lock.json,gitignore,git,'jpg',
'jpeg','png','gif','svg','webp','ico','bmp','mp4','mov','mkv','webm','avi',

```
TOTAL_LINES 42942

ts           14798
css          10473
backend-js   9454
hbs          4819
md           2057
mjs          770
html         390
json         118
yml          41
noext        21
npmrc        1
--- Top files by lines ---
    9874 src\public\css\app.css
    1971 src\public\js\browse.js
    1461 src\views\pages\erd.hbs
    1068 src\public\js\seed.js
    1020 src\public\js\inspector.js
     904 src\public\js\query.js
     793 src\public\js\forms.js
     741 src\public\js\sync.js
     668 test\smoke.test.ts
     635 src\public\js\search.js
     607 src\sql\error-analyzer.ts
     599 src\public\css\input.css
     579 docs\EXAMPLES.md
     579 test\database.test.ts
     576 src\modules\rows\rows.service.ts
     575 src\modules\rows\rows.routes.ts
     536 src\modules\search\search.service.ts
     485 src\views\pages\sync.hbs
     481 scripts\capture-screenshots.mjs
     467 src\types\api.ts
     463 test\chain-seeder.test.ts
     458 test\sync.test.ts
     454 test\unified-seed-engine.test.ts
     450 docs\FilesStats.md
     432 src\views\pages\table.hbs
     407 src\public\js\schema.js
     390 testapp\index.html
     388 test\serverless.test.ts
     371 src\views\pages\seed.hbs
     368 README.md
     362 src\core\transfer\dialect-mapper.ts
     332 src\public\js\home.js
     329 test\postgres.test.ts
     320 src\views\pages\schema.hbs
     312 src\core\diff\data-differ.ts
     300 src\core\transfer\sync-engine.ts
     297 src\sql\generator.ts
     295 src\core\diff\schema-differ.ts
     288 src\views\pages\seed-select.hbs
     281 test\erd.test.ts
     278 src\views\pages\home.hbs
     276 src\modules\tables\tables.service.ts
     275 testapp\seed-data.js
     273 src\cli\args.ts
     265 docs\SECURITY.md
     262 src\public\js\app.js
     262 test\manager.test.ts
     261 src\public\js\common.js
     258 src\modules\seed\seed.service.ts
     255 src\views\pages\databases.hbs
     247 src\app.ts
     244 src\utils\datatype.ts
     231 src\modules\seed\seed.routes.ts
     222 src\public\js\databases.js
     220 src\cli\runner.ts
     219 src\utils\common.ts
     218 src\public\js\designer.js
     216 scripts\copy-assets.mjs
     216 test\seeder.test.ts
     204 test\generator.test.ts
     203 src\serverless.ts
     203 test\auth.test.ts
     199 src\modules\tables\tables.routes.ts
     176 test\search.test.ts
     175 src\modules\schema\schema.routes.ts
     167 src\modules\sync\sync.routes.ts
     156 src\modules\databases\databases.routes.ts
     156 src\views\pages\query.hbs
     154 test\error-analyzer.test.ts
     152 src\cli\config.ts
     151 src\views\partials\sidebar.hbs
     141 docs\API.md
     139 test\streaming-cursor.test.ts
     137 src\utils\stream.ts
     130 src\modules\databases\databases.service.ts
     129 src\views\pages\info.hbs
     117 src\auth\config.ts
     113 src\modules\query\query.service.ts
     111 src\views\pages\login.hbs
     107 src\auth\crypto.ts
     104 scripts\publish.js
     103 src\views\pages\designer.hbs
     100 src\auth\middleware.ts
     100 src\modules\rows\display.helper.ts
     100 src\utils\icons.ts
     100 src\views\partials\navbar.hbs
      96 src\views\layouts\main.hbs
      95 docs\screenshots\index.md
      95 src\core\diff\patch-generator.ts
      93 src\auth\routes.ts
      93 testapp\server.js
      92 tailwind.config.js
      89 src\modules\search\search.types.ts
      84 testapp\README.md
      81 package.json
      76 src\modules\sync\sync.service.ts
      75 CONTRIBUTING.md
      75 test\datatype.test.ts
      72 src\core\transfer\topological-sort.ts
      71 test\harness.ts
      69 src\modules\erd\erd.service.ts
      69 src\views\pages\form.hbs
      68 test\csv.test.ts
      67 scripts\generate-hash.mjs
      64 src\utils\csv.ts
      62 src\modules\index.ts
      61 src\core\transfer\masking.ts
      60 src\utils\colors.ts
      57 src\modules\query\query.routes.ts
      56 src\core\router.ts
      56 src\public\js\api.js
      55 src\modules\schema\schema.service.ts
      52 src\utils\logger.ts
      46 src\sql\classifier.ts
      44 test\classifier.test.ts
      42 src\modules\search\search.routes.ts
      41 .github\workflows\checkLatestVersion.yml
      40 src\auth\types.ts
      40 src\core\errors.ts
      38 src\modules\rows\blob.helper.ts
      35 src\modules\erd\erd.routes.ts
      24 src\core\result.ts
      23 src\index.ts
      22 src\core\context.ts
      21 LICENSE
      21 tsconfig.json
      16 testapp\package.json
      12 src\views\pages\error.hbs
       6 scripts\clean-dist.mjs
       5 src\auth\index.ts
       4 src\cli\index.ts
       4 src\cli.ts
       4 src\core\index.ts
       4 src\modules\rows\index.ts
       4 src\utils\index.ts
       3 src\modules\search\index.ts
       2 src\modules\databases\index.ts
       2 src\modules\erd\index.ts
       2 src\modules\query\index.ts
       2 src\modules\schema\index.ts
       2 src\modules\seed\index.ts
       2 src\modules\sync\index.ts
       2 src\modules\tables\index.ts
       2 src\sql\index.ts
       2 src\views\partials\icon.hbs
       1 .npmrc
```
