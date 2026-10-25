/**
 * Mermaid sources covering every diagram type Pele draws and the authoring features that
 * reach its SVG output: styles, classes, link styles, notes, subgraphs, links, images and
 * front matter. The sanitizer corpus test renders each with the pinned Pele and requires that
 * the sanitizer drops nothing, so an upgrade that emits new markup fails a test instead of
 * silently losing output or widening the trust boundary (#171).
 */
export const MERMAID_CORPUS: Readonly<Record<string, string>> = {
  flowchart: `---
title: Release flow
---
flowchart TD
  accTitle: Release flow
  accDescr: How a change ships
  start([Start]) --> build[Build the app]
  build --> check{Tests pass?}
  check -->|yes| ship[(Release store)]
  check -.->|no| fix>Fix the failure]
  fix ==> build
  ship --> done((Done))
  subgraph review [Review]
    direction LR
    pr[/Pull request/] --> approve[\\Approve\\]
    approve --> merge{{Merge}}
  end
  done --> review
  classDef warn fill:#fde68a,stroke:#b45309,stroke-width:2px,color:#7c2d12,font-weight:bold
  class fix warn
  style ship fill:#dbeafe,stroke:#1d4ed8,stroke-dasharray:4 2,rx:6,ry:6
  linkStyle 0 stroke:#16a34a,stroke-width:3px
  click build "https://example.com/build" "Open the build"
  click check call checkFn()
`,
  flowchartShapes: `graph LR
  a[Rect] --- b(Round) --o c[[Sub]] --x d[(DB)]
  d <--> e{Diamond} -- label --> f{{Hex}}
  f --> g[/Lean/] --> h((Circle)) --> i(((Double)))
  i ~~~ j@{ shape: doc, label: "Document" }
  A1["Quoted &amp; escaped &lt;b&gt;"] --> B1["\`**Markdown** _label_\`"]
  B1 --> C1["fa:fa-car Icon text"]
`,
  sequence: `sequenceDiagram
  autonumber
  actor User
  participant App as BiBCode
  participant Server
  User->>App: Send a message
  activate App
  App->>+Server: thread.message-sent
  Note right of Server: Persists the turn
  Server-->>-App: ack
  alt success
    App-->>User: Show the reply
  else failure
    App--xUser: Show the error
  end
  loop every delta
    Server-)App: stream
  end
  rect rgb(200, 220, 255)
    App->>App: Render
  end
  opt diagrams
    App->>App: Draw
  end
  par parallel
    App->>Server: a
  and
    App->>Server: b
  end
  critical lock
    Server->>Server: write
  end
  break when idle
    Server->>App: done
  end
  deactivate App
`,
  classDiagram: `classDiagram
  direction LR
  class Animal {
    <<abstract>>
    +String name
    -int age
    +makeSound()* void
    +move(distance) bool$
  }
  class Dog~T~ {
    +bark()
  }
  Animal <|-- Dog
  Animal "1" *-- "many" Leg : has
  Dog o-- Toy
  Dog ..> Food
  Dog ..|> Pet
  Toy -- Owner
  note for Dog "Good dog"
  classDef highlight fill:#f9f,stroke:#333
  class Toy:::highlight
`,
  state: `stateDiagram-v2
  [*] --> Idle
  Idle --> Running : start
  Running --> Paused : pause
  Paused --> Running : resume
  Running --> [*]
  state Running {
    [*] --> Fetching
    Fetching --> Rendering
    Rendering --> [*]
  }
  state fork_state <<fork>>
  Idle --> fork_state
  fork_state --> A
  fork_state --> B
  state choice <<choice>>
  A --> choice
  choice --> Idle: retry
  note right of Paused : Waiting for input
  classDef busy fill:#fee2e2,stroke:#991b1b
  class Running busy
`,
  er: `erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ LINE_ITEM : contains
  CUSTOMER }|..|{ DELIVERY_ADDRESS : uses
  CUSTOMER {
    string name PK
    string email UK "login"
    int age
  }
  ORDER {
    int id PK
    int customerId FK
  }
`,
  pie: `pie showData
  title Languages
  "TypeScript" : 55
  "Rust" : 35
  "CSS" : 10
`,
  gantt: `gantt
  title Release plan
  dateFormat YYYY-MM-DD
  axisFormat %m/%d
  excludes weekends
  section Build
  Design          :done,    des1, 2026-10-01, 7d
  Implementation  :active,  impl, after des1, 10d
  section Ship
  Review          :crit,    rev, after impl, 3d
  Release         :milestone, rel, after rev, 0d
`,
  gitGraph: `gitGraph
  commit id: "init"
  branch feature
  checkout feature
  commit id: "work" tag: "v0.1"
  commit type: HIGHLIGHT
  checkout main
  commit type: REVERSE
  merge feature
  cherry-pick id: "work"
  commit
`,
  mindmap: `mindmap
  root((BiBCode))
    Desktop
      Tauri
      ::icon(fa fa-desktop)
    Server[Server]
      Rust
      Axum
    Web)Web(
      React
      **Markdown**
`,
  timeline: `timeline
  title Releases
  section 2026
    v0.10 : Profiler : Worktrees
    v0.11 : Streaming Markdown
  section Next
    v0.12 : Diagrams
`,
  journey: `journey
  title Draw a diagram
  section Write
    Type the fence: 5: User
    Close the fence: 3: User, Agent
  section Read
    See the diagram: 5: User
`,
  xychart: `xychart-beta
  title "Render time"
  x-axis [jan, feb, mar, apr]
  y-axis "Milliseconds" 0 --> 100
  bar [20, 40, 35, 60]
  line [25, 45, 30, 55]
`,
  quadrantChart: `quadrantChart
  title Effort and impact
  x-axis Low effort --> High effort
  y-axis Low impact --> High impact
  quadrant-1 Plan
  quadrant-2 Do now
  quadrant-3 Skip
  quadrant-4 Delegate
  Diagrams: [0.3, 0.8]
  Zoom: [0.7, 0.4]
  Expand:::accent: [0.5, 0.6]
  classDef accent color: #109060, radius: 8
`,
  requirement: `requirementDiagram
  requirement safe_svg {
    id: 1
    text: the SVG is sanitized
    risk: high
    verifymethod: test
  }
  element sanitizer {
    type: module
  }
  sanitizer - satisfies -> safe_svg
`,
  c4: `C4Context
  title System context
  Person(user, "User", "Reads diagrams")
  System(app, "BiBCode", "Draws Mermaid")
  System_Ext(agent, "Agent", "Writes Mermaid")
  Rel(user, app, "Uses")
  Rel(agent, app, "Replies to")
  UpdateRelStyle(user, app, $textColor="blue", $lineColor="red")
`,
  sankey: `sankey-beta
Agent,Markdown,40
Markdown,Diagram,25
Markdown,Code,15
Agent,Tools,20
`,
  block: `block-beta
  columns 3
  a["Parse"] b["Render"] c["Sanitize"]
  space d(("Insert")) space
  a --> b
  b --> c
  c --> d
  style d fill:#e0e7ff,stroke:#4338ca
`,
  packet: `packet-beta
  0-15: "Source port"
  16-31: "Destination port"
  32-63: "Sequence number"
`,
  kanban: `kanban
  todo[To do]
    k1[Write the design]
  doing[In progress]
    k2[Draw diagrams]@{ assigned: 'agent', priority: 'High' }
  done[Done]
    k3[Pin the packages]
`,
  architecture: `architecture-beta
  group api(cloud)[API]
  service db(database)[Database] in api
  service server(server)[Server] in api
  service disk(disk)[Storage] in api
  db:L -- R:server
  disk:T -- B:db
`,
  radar: `radar-beta
  title Diagram quality
  axis s["Speed"], f["Fidelity"], z["Size"]
  curve p["Pele"]{90, 70, 95}
  curve m["Reference"]{40, 100, 30}
  max 100
`,
  treemap: `treemap-beta
"Bundle"
    "Renderer": 30
    "Core": 40
    "Sanitizer": 20
`,
  info: `info`,
  invalidFlowchart: `flowchart TD
  A[Start --> B
`,
};
