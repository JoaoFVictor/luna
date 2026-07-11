# Luna Studio — auditoria de produto e plano de redesenho

Status: proposta de produto e arquitetura de interface. Este documento não autoriza nem contém implementação.

## 1. Objetivo

Transformar o Luna Studio de um painel técnico de autoria em um construtor visual de automações e agentes, comparável em fluidez a n8n, Make e Node-RED, sem enfraquecer os invariantes da Luna:

- roteamento determinístico;
- YAML e schemas como representação canônica;
- validação e compilação autoritativas no servidor;
- capabilities, policies e side effects explícitos;
- drafts isolados e apply controlado;
- separação entre adapter, workflow, agent, capability, provider e runtime.

O produto deve permitir que uma pessoa monte, teste e aplique um fluxo comum sem conhecer `registration`, `capability`, `after`, JSON Schema, invocation JSON ou a estrutura dos arquivos do repositório.

## 2. Método e escopo da auditoria

A avaliação combinou:

1. inspeção do Studio rodando localmente em Chromium controlado por Puppeteer;
2. jornadas reais nas telas Início, Workflows, editor de workflow, Launch, Agents, Library, Configuration e Runs;
3. inspeção dos componentes React e das integrações com React Flow;
4. comparação com documentação oficial de n8n, Make, Node-RED, React Flow e W3C;
5. preservação explícita das fronteiras arquiteturais da Luna.

Não foram executados apply, publicação, run real ou alteração de recursos do projeto durante a auditoria.

## 3. Resumo executivo

O Studio atual é um excelente console de inspeção para quem já conhece internamente a Luna, mas ainda é um produto fraco para criação visual.

O problema central não é aparência. É o modelo de interação:

- o usuário manipula conceitos de implementação antes de expressar sua intenção;
- o canvas depende da compilação e pode desaparecer quando é mais necessário;
- React Flow é usado como visualizador de uma DAG, não como editor de workflow;
- criação, configuração, teste, execução e diagnóstico estão fragmentados;
- adapter, roteamento e launch são apresentados como pipeline técnico;
- agents são tratados como documentos de configuração e schemas;
- recursos internos são exibidos como catálogos planos, sem linguagem orientada a tarefas;
- segurança aparece como detalhes repetidos, em vez de uma revisão contextual de impacto.

Diagnóstico objetivo: hoje o Studio é **schema-first**. O produto desejado precisa ser **intent-first**, mantendo schema-first apenas na camada interna e no modo avançado.

## 4. Evidências observadas no produto atual

### 4.1 Densidade e hierarquia

Medições da sessão auditada em viewport de 1440 × 1000:

| Superfície | Evidência |
| --- | --- |
| Editor de workflow, Design | 43 botões/controles visíveis, 7 abas, 3 colunas e 2.631 px de altura |
| Editor de workflow, YAML | arquivo renderizado em uma página de 11.164 px de altura |
| Configuration | 16 campos e 2.835 px de altura para um workflow |
| Library | 21 capabilities e 67 registrations apresentados como catálogo técnico |
| Launch | 5 campos, dois modos de entrada e múltiplas confirmações antes do run |
| Agents | tabela com ID, mode, model profile, tools e revision como colunas primárias |

### 4.2 Editor de workflow

Em um draft real de code review com 16 nodes:

- o outline lista todos os nodes;
- o canvas central mostra somente “DAG ainda não compilada”;
- o inspector global apresenta postura de acesso, capabilities, registrations, `requires`, config declaration, execution, observability e subagent policy;
- o usuário precisa escolher entre Salvar, Validar, Compilar, Diff & apply e Preparar launch;
- há abas separadas para Design, YAML, Schemas, Compiled, Diff, Run e Problems;
- erros não são prioritariamente projetados nos nodes ou conexões.

O espaço mais valioso da tela fica vazio enquanto as laterais concentram detalhes técnicos.

### 4.3 React Flow

A implementação atual desabilita explicitamente a autoria visual:

- handles usam `opacity-0`;
- cada node é criado com `connectable: false`;
- `nodesConnectable={false}`;
- não há `onConnect`;
- edges não podem ser removidas ou reconectadas;
- o grafo recebe somente o workflow compilado;
- a posição visual é editável, mas a topologia não;
- o card prioriza ID, capability ID e kind, não a intenção do passo;
- não existe criação por drag-and-drop, edge drop ou botão contextual;
- não existe toolbar contextual de node/edge;
- não existe feedback visual de configuração incompleta no modo de autoria.

Isso faz do React Flow um diagrama navegável. A biblioteca já oferece seleção, conexão, remoção, drag-and-drop, validação, prevenção de ciclos, criação de node ao soltar uma conexão, reconexão, toolbar e acessibilidade por teclado. A própria documentação descreve drag-and-drop como padrão comum de editores de workflow e mostra `onConnect`, `onNodesChange` e `onEdgesChange` como base do fluxo controlado. [React Flow — Drag and Drop](https://reactflow.dev/examples/interaction/drag-and-drop) e [React Flow — exemplos](https://reactflow.dev/examples).

### 4.4 Launch e adapters

O Launch exige que o usuário compreenda antecipadamente:

- adapter;
- string opaca;
- invocation JSON;
- routing preview;
- first-match;
- plano autoritativo;
- efeitos técnicos como `credential_read`, `network_read` e `process_execution`;
- diferença entre preview, plan e execução.

Essa precisão é boa para auditoria, mas inadequada como jornada padrão. O usuário quer “Testar este workflow com este PR” ou “Executar usando um issue do Plane”.

### 4.5 Agents

A lista prioriza metadados internos. O detalhe do agent exibe JSON Schema cru como elemento dominante. A edição está dividida em General, Instructions, Output contract, Resources e Usage & impact, além do ciclo externo de draft, validação e apply.

O usuário deveria primeiro entender:

- o que este agent faz;
- quais entradas recebe;
- quais tools pode usar;
- qual saída entrega;
- onde é usado;
- como testá-lo.

Model profile, schema reference e arquivos continuam necessários, mas são detalhes avançados.

### 4.6 Library

Library mistura descoberta de blocos utilizáveis com inspeção do registry. `Capabilities` e `Registrations` são conceitos de arquitetura, não categorias naturais para criação.

Para autoria, o usuário precisa de uma paleta organizada por intenção. Para diagnóstico, precisa de um Registry Explorer separado.

### 4.7 Configuration

O formulário atual projeta diretamente a estrutura do schema, mostra referências `$.config` e inclui um botão “Salvar campo” repetido. Isso gera páginas extensas, ausência de visão geral e custo alto para alterações relacionadas.

O modo principal deve agrupar campos semanticamente, salvar como conjunto e explicar impacto. Caminhos JSON e classificação devem ficar no modo técnico.

### 4.8 Runs

Runs tem bons fundamentos — catálogo, logs, grafo e artifacts — mas está separado da autoria. Na auditoria, uma run histórica selecionada dentro do workflow retornou recurso não encontrado em inglês e um request ID, sem recuperação contextual.

n8n permite carregar dados de execução anterior de volta ao canvas e refazer uma execução com workflow original ou atual. [n8n — All executions](https://docs.n8n.io/workflows/executions/all-executions/). Essa ligação entre execução e edição precisa existir na Luna.

## 5. Princípios do redesenho

### 5.1 Intenção antes da implementação

Mostrar “Receber pull request” antes de `github-pr-url`; “Coletar contexto” antes de `context.collect_context`; “Publicar revisão” antes da registration correspondente.

### 5.2 Canvas sempre disponível

O source projetável deve gerar o grafo de autoria mesmo inválido ou ainda não compilado. A última compilação válida é uma camada de verificação, não a condição para renderizar.

### 5.3 Progressive disclosure

Exibir somente a configuração necessária para completar o passo atual. W3C recomenda apresentar as funções mais relevantes e frequentes e revelar complexidade adicional sob demanda. [W3C — Presentation](https://www.w3.org/WAI/people-use-web/tools-techniques/presentation/).

### 5.4 Segurança contextual

Não esconder side effects. Traduzir, agrupar e apresentá-los no momento correto:

- no node: “Lê credenciais” ou “Publica comentário”;
- no teste: efeitos simulados ou bloqueados;
- no apply/run: resumo consolidado e confirmação.

### 5.5 Uma ação primária por etapa

- durante autoria: `Testar`;
- quando pronto: `Aplicar`;
- durante execução: `Executar`;
- em erro: `Corrigir` ou `Tentar novamente`.

Salvar, validar e compilar devem ocorrer automaticamente ou aparecer como estados, não como decisões concorrentes.

### 5.6 Modo simples e modo técnico sobre o mesmo modelo

Não criar dois editores. Criar duas projeções sobre a mesma fonte e as mesmas operações canônicas.

## 6. Nova arquitetura de informação

### 6.1 Navegação principal proposta

| Atual | Proposto | Motivo |
| --- | --- | --- |
| Início | Visão geral | tarefas recentes, problemas e atalhos |
| Workflows | Workflows | catálogo e editor visual |
| Launch | incorporado a Workflows + Executar | launch deixa de ser conceito isolado |
| Agents | Agents | criação, teste e uso |
| Library | Blocos | paleta humana; Registry em avançado |
| Configuration | Conexões e configurações | separar conexões, routing e config de workflow |
| Runs | Execuções | linguagem consistente e ligação com canvas |

### 6.2 Estrutura do editor

```text
┌────────────────────────────────────────────────────────────────────┐
│ ← Workflows  Revisão de código   Salvo ✓   Desfazer  Testar Aplicar│
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│                         CANVAS                                     │
│                                                                    │
│  GitHub PR ──→ Contexto ──→ Agente revisor ──→ Publicar review    │
│                      │                                             │
│                      └── +                                         │
│                                                                    │
│  [＋ Adicionar passo]                              [− 100% +][mapa] │
├────────────────────────────────────────────────────────────────────┤
│ Execução, dados e problemas                                ▲       │
└────────────────────────────────────────────────────────────────────┘
```

- paleta abre por `+`, `Tab`, drag-and-drop ou ao soltar uma conexão no vazio;
- inspector abre somente ao selecionar um item;
- drawer inferior reúne teste, input/output, logs e problemas;
- YAML, schemas, compiled e diff ficam em `Avançado`;
- outline vira acessibilidade/navegador recolhível, não coluna permanente.

## 7. Redesenho de Workflows

### 7.1 Criação

Trocar o modal técnico por um início orientado a objetivo:

1. “O que você quer automatizar?”
2. escolher template ou “Começar do zero”;
3. definir nome humano; ID é gerado automaticamente;
4. escolher como o fluxo começa;
5. abrir imediatamente o canvas.

Templates devem ter:

- nome e resultado esperado;
- diagrama pequeno;
- integrações necessárias;
- agents necessários;
- efeitos externos;
- tempo estimado de configuração.

Arquivos gerados, versionamento do template e capabilities ficam em detalhes técnicos.

### 7.2 Paleta de nodes

Categorias propostas:

- **Entradas**: execução manual, adapter, webhook, schedule;
- **Contexto e dados**: coletar contexto, transformar, validar, combinar;
- **Agents e IA**: executar agent, loop com reparo, classificar, gerar;
- **Fluxo**: condição, router, gate humano, paralelo, repetição, espera;
- **Repositório**: preparar workspace, ler diff, editar, commit controlado;
- **Saídas**: relatório, comentário, review, artifact, change request;
- **Utilitários**: execução local autorizada e operações determinísticas.

Cada item deve conter:

- rótulo humano;
- descrição de uma frase;
- ícone e categoria;
- tags pesquisáveis;
- entradas e saídas resumidas;
- badge de efeito externo;
- ID técnico secundário;
- indicação de indisponibilidade e como corrigir.

### 7.3 Nodes visuais

Um node deve comunicar estado, não configuração completa:

```text
┌────────────────────────────┐
│ 🤖 Revisar alterações   ✓  │
│ Agent: change-reviewer     │
│ 1 entrada · 1 saída        │
│                    240 ms  │
└────────────────────────────┘
```

Estados:

- não configurado;
- configurado, ainda não testado;
- validando;
- válido;
- aviso;
- erro;
- executando;
- sucesso;
- aguardando entrada humana;
- ignorado ou cancelado.

Capability ID e kind ficam em tooltip ou detalhes avançados.

### 7.4 Conexões e dependências

- handles visíveis no hover, foco e seleção;
- arrastar para conectar;
- validação imediata de compatibilidade e ciclos;
- soltar no vazio abre a paleta;
- botão `+` sobre a edge insere passo intermediário;
- edge selecionada permite remover ou reconectar;
- condição é rotulada na edge;
- `after` é derivado pela operação canônica;
- dependência técnica continua editável em modo avançado;
- diferença entre dependência de execução e referência de dados deve ser explicada visualmente.

Make permite configurar filtros clicando na conexão e dá nome visível à condição, o que facilita ler o cenário. [Make — filtros](https://help.make.com/step-4-add-a-filter). Rotas e fallback também são representados como elementos do fluxo. [Make — Router](https://help.make.com/router).

### 7.5 Inspector

Ordem padrão:

1. nome do passo;
2. ação ou agent;
3. conexão/credencial quando aplicável;
4. inputs essenciais;
5. resultado esperado;
6. teste do node;
7. seções recolhidas: erro e retry, recursos, policies, contracts, artifacts e JSON.

Não mostrar por padrão capabilities declaradas, registrations usadas, `requires`, observability ou config declaration no inspector global.

### 7.6 Mapeamento de dados

Criar um data mapper baseado nos schemas e nas saídas observadas:

- painel `Entrada` com dados do node anterior;
- busca por campo;
- drag-and-drop para parâmetros;
- preview do valor;
- indicação de origem;
- suporte a texto + tokens;
- expressão manual como opção avançada;
- incompatibilidade de tipo visível antes da execução.

n8n permite arrastar dados do painel INPUT para parâmetros e gera a expressão automaticamente. [n8n — Data mapping UI](https://docs.n8n.io/data/data-mapping/data-mapping-ui/).

### 7.7 Validação, compilação e salvamento

Fluxo proposto:

```text
mutação visual
  → atualização otimista do grafo
  → operação canônica no servidor
  → source atualizado
  → validação incremental com debounce
  → compilação em background quando elegível
  → diagnóstico projetado no node/campo/edge
```

Estados no header:

- `Salvando…`;
- `Salvo`;
- `2 problemas`;
- `Pronto para testar`;
- `Alterações não aplicadas`.

O usuário não deve precisar conhecer a diferença operacional entre salvar, validar e compilar para executar a jornada comum.

### 7.8 Teste dentro do canvas

Oferecer:

- testar node;
- executar até aqui;
- executar a partir daqui quando houver fixture confiável;
- testar workflow com dados de exemplo;
- pin de dados de entrada/saída;
- selecionar uma execução anterior;
- comparar saída atual e anterior;
- abrir artifacts junto ao node produtor.

## 8. Redesenho de Launch e adapters

### 8.1 Renomear a experiência

Usar `Executar workflow` ou `Testar workflow`. “Launch” pode permanecer como termo interno.

### 8.2 Adapter como trigger e fonte de teste

No workflow, o adapter aparece como entrada:

```text
Quando: Pull request do GitHub
Conexão: GitHub principal
Rota prevista: Code review
```

Ao testar:

```text
Escolha uma entrada
  URL de pull request
  Payload de exemplo
  Invocation avançada
```

O modo `Invocation JSON` fica em avançado.

### 8.3 Efeitos traduzidos

| Técnico | Apresentação |
| --- | --- |
| `credential_read` | Usará a conexão GitHub selecionada |
| `network_read` | Consultará dados externos |
| `process_execution` | Poderá executar um processo local |
| publicação | Poderá publicar comentário/review |

Manter detalhes expansíveis com IDs e policies.

### 8.4 Preview e plano

Preview e plano autoritativo continuam existindo, mas a interface apresenta uma revisão única:

```text
Antes de executar

Entrada: PR #392
Workflow escolhido: Revisão de código
Passos: 16
Efeitos: ler GitHub, executar agent, publicar review

[Voltar] [Executar]
```

Se a rota for diferente da esperada, explicar em linguagem natural e oferecer abrir as regras de routing.

## 9. Redesenho de Agents

### 9.1 Catálogo

Cards ou tabela simplificada:

- nome;
- descrição;
- modo: leitura/escrita;
- model profile com nome amigável;
- número de workflows que usam;
- último teste;
- status.

Revision e referências técnicas ficam em detalhes.

### 9.2 Criação em etapas

1. propósito e nome;
2. instruções;
3. ferramentas permitidas;
4. formato de resposta;
5. teste;
6. revisão de autoridade;
7. aplicar.

Um agent mínimo não deveria exigir edição consciente de arquivos ou JSON Schema.

### 9.3 Output contract

Oferecer três níveis:

- resposta textual;
- builder estruturado com campos;
- JSON Schema avançado.

Mostrar exemplo de saída e validação lado a lado. O schema cru não deve dominar o painel de leitura.

### 9.4 Tools, skills e MCP

Apresentar como permissões e recursos pesquisáveis:

- o que o agent pode fazer;
- por que precisa;
- leitura ou escrita;
- disponibilidade no runtime selecionado;
- risco e confirmação;
- origem: tool, skill ou MCP.

Não esconder a diferença técnica; explicá-la em uma seção avançada.

### 9.5 Test bench

O teste deve ser central na página:

- selecionar cenário de teste;
- fornecer contexto;
- executar;
- visualizar resposta estruturada;
- ver tool calls;
- validar schema;
- comparar com teste anterior;
- promover fixture aprovada.

## 10. Blocos, registry e configurações

### 10.1 Separar Blocos de Registry

`Blocos` é a biblioteca para autores. `Registry` é a superfície avançada para mantenedores.

Blocos devem ser pesquisáveis por intenção, provider, categoria e efeito. Registry mantém capability, registration, versão, dependências e schemas.

### 10.2 Conexões

Criar uma seção própria para providers e conexões:

- GitHub, Plane e futuros providers;
- estado da conexão;
- teste de conexão;
- recursos que usam;
- escopos e efeitos;
- configuração sem expor secrets.

### 10.3 Routing

Criar editor legível de regras ordenadas:

```text
1. Se provider = github e evento = pull_request → Revisão de código
2. Se provider = plane e evento = issue → Implementação
3. Senão → sem rota
```

Permitir testar uma entrada e destacar a primeira regra correspondente. A ordem e o first-match continuam determinísticos.

### 10.4 Configuração de workflow

- seções por domínio;
- descrições humanas fornecidas pelo schema;
- salvar alterações relacionadas de uma vez;
- resumo do diff antes de aplicar;
- campos avançados recolhidos;
- referências `$.config` somente no modo técnico;
- busca e navegação lateral em schemas grandes.

## 11. Execuções e observabilidade

### 11.1 Lista

- nome curto e humano;
- workflow;
- origem/trigger;
- status;
- duração;
- horário;
- ação rápida: abrir, repetir, usar dados no editor.

IDs completos permanecem copiáveis, não como título principal.

### 11.2 Detalhe

Usar o mesmo canvas do editor, sobreposto com estado da execução:

- node atual pulsando;
- sucesso/erro por node;
- duração, tentativas e artifacts;
- clique abre input, output e logs daquele node;
- erro principal destacado;
- branches não executados visíveis;
- botão `Editar e tentar novamente` carrega dados no draft.

### 11.3 Erros

Toda mensagem deve responder:

1. o que falhou;
2. onde falhou;
3. impacto;
4. ação recomendada;
5. detalhes técnicos expansíveis.

Exemplo:

```text
Esta execução histórica não está mais disponível.
Ela pode ter sido removida ou pertencer a outro catálogo.

[Escolher outra execução] [Ver detalhes técnicos]
```

Request ID e mensagem original ficam nos detalhes.

## 12. Plano técnico para React Flow

### 12.1 Separar modelos

Definir três projeções explícitas:

- `AuthoringGraph`: derivado do source, tolerante a estado incompleto;
- `CompiledGraph`: resultado autoritativo, usado para validação e comparação;
- `RunGraph`: snapshot imutável com estados de execução.

O canvas recebe uma projeção conforme o modo, mas usa os mesmos componentes visuais básicos.

### 12.2 Estado controlado

Implementar estado controlado para:

- `onNodesChange` para posição e seleção;
- `onEdgesChange` para seleção e remoção autorizada;
- `onConnect` para criar dependência;
- `onReconnect` para mudar dependência;
- `onConnectStart/onConnectEnd` para quick-add;
- `isValidConnection` para compatibilidade e prevenção de ciclo;
- `onNodesDelete/onEdgesDelete` para operações canônicas;
- drag-and-drop/pointer events para inserir nodes.

Não persistir uma edge local como verdade final. Aplicar optimistic update, enviar operação ao servidor e reconciliar com o source retornado.

### 12.3 Custom nodes

Criar tipos visuais por função, não necessariamente por registration:

- trigger/adapter;
- built-in/action;
- agent;
- condition/router;
- human gate/interrupt;
- pattern/subflow;
- output/publisher.

Cada tipo compartilha shell, estado, handles, toolbar, badges e acessibilidade.

### 12.4 Custom edges

Edges devem suportar:

- seta e direção claras;
- label de condição;
- botão de inserção;
- toolbar ao selecionar;
- área de interação maior;
- erro/aviso;
- reconexão;
- distinção visual entre controle e referência de dados quando ambas forem exibidas.

### 12.5 Layout

- manter posições manuais em sidecar;
- usar ELK para layout automático de DAGs complexas;
- preservar nodes fixados;
- animar transições de layout;
- oferecer direção vertical/horizontal;
- usar groups/subflows para reduzir complexidade;
- fit view somente no carregamento ou por comando, nunca após cada mutação.

O template oficial de workflow editor do React Flow combina Tailwind/shadcn, ELK, drag-and-drop e runner, validando essa direção técnica. [React Flow — Workflow Editor](https://reactflow.dev/ui/templates/workflow-editor).

### 12.6 Acessibilidade

Preservar e ampliar o trabalho já existente:

- outline recolhível completo por teclado;
- seleção e remoção de node/edge por teclado;
- alternativa “Conectar a…” no toolbar;
- handles com área adequada;
- descrição do estado e dos erros;
- foco previsível ao criar/remover;
- não depender somente de cor;
- reduzir animação conforme preferência do usuário.

React Flow já oferece seleção e movimentação por teclado e elementos auxiliares como Controls, MiniMap e NodeToolbar. [React Flow — visão geral](https://reactflow.dev/).

### 12.7 Performance

- manter `nodeTypes` e `edgeTypes` fora do render;
- memoizar cards e selectors;
- evitar passar catálogo completo em `data` de cada node;
- separar seleção, posições e conteúdo para reduzir rerenders;
- virtualizar paletas e inspectors extensos;
- debounce de layout e validação, não de feedback local;
- testar grafos com 20, 100 e 500 nodes;
- medir FPS de drag, tempo de first render e tempo de reconciliação.

## 13. Mudanças necessárias na API/BFF

Priorizar operações semânticas, não edição textual:

- adicionar node com ID sugerido pelo servidor;
- remover node com plano de impacto;
- conectar/desconectar/reconectar nodes;
- inserir node entre dependências;
- configurar campos essenciais;
- obter catálogo de blocos já enriquecido com rótulos e categorias;
- obter schemas de input/output normalizados para mapper;
- validar conexão antes de persistir;
- validar/compilar incrementalmente;
- testar node ou trecho com fixture;
- carregar dados de run para o editor;
- obter diagnósticos com `resource`, `nodeId`, `fieldPath`, `edge` e ação sugerida.

As operações continuam convertidas no servidor para mutações seguras do source.

## 14. Metadados de UX necessários

O registry precisa aceitar metadados de apresentação sem duplicar autoridade funcional:

- `display_name`;
- `description` orientada a tarefa;
- `category`;
- `icon` ou chave de ícone;
- `keywords`;
- `input_ports` e `output_ports` de apresentação;
- campos essenciais versus avançados;
- exemplos;
- resumo traduzível de efeitos;
- documentação curta;
- status de maturidade.

Esses metadados não decidem roteamento, policy ou execução.

## 15. Roadmap recomendado

### Fase 0 — contrato de produto e métricas

- definir vocabulário humano;
- mapear operações canônicas existentes;
- criar `AuthoringGraph` tolerante;
- definir metadados da paleta;
- instrumentar métricas de jornada.

### Fase 1 — canvas realmente editável

- renderizar source antes da compilação;
- handles visíveis;
- criar/remover/reconectar edges;
- quick-add e paleta pesquisável;
- nodes com estados de configuração;
- inspector básico e avançado;
- validação e compilação em background;
- diagnósticos inline.

Esta fase é o corte mínimo para chamar o Studio de editor visual.

### Fase 2 — dados e testes

- data mapper;
- fixtures e pin de dados;
- teste de node e “executar até aqui”;
- drawer de input/output/logs;
- carregar execução anterior no canvas;
- comparação de resultados.

### Fase 3 — adapters, agents e configurações

- adapter como trigger;
- execução incorporada ao workflow;
- builder de agent e output contract;
- conexões/providers;
- routing legível e testável;
- configuração agrupada.

### Fase 4 — produtividade e escala

- undo/redo;
- copiar/colar/duplicar;
- groups/subflows;
- comentários;
- atalhos;
- versões visuais;
- templates refinados;
- sugestões contextuais.

### Fase 5 — criação assistida

Somente depois do editor visual estar consistente:

- gerar draft a partir de linguagem natural;
- explicar workflow;
- sugerir próximo passo;
- corrigir configuração com aprovação;
- gerar fixtures.

IA não deve substituir fundamentos ausentes de interação.

## 16. Priorização objetiva

| Prioridade | Mudança | Impacto | Esforço relativo |
| --- | --- | --- | --- |
| P0 | Canvas derivado do source | crítico | médio |
| P0 | Conexões visuais completas | crítico | médio/alto |
| P0 | Paleta humana e pesquisável | crítico | médio |
| P0 | Inspector com progressive disclosure | alto | médio |
| P0 | Diagnósticos inline | alto | médio |
| P0 | Autosave + validate/compile em background | alto | médio |
| P1 | Data mapper | crítico para produtividade | alto |
| P1 | Teste por node/trecho | alto | alto |
| P1 | Adapter como trigger | alto | médio |
| P1 | Builder de agent | alto | médio/alto |
| P1 | Run sobre o mesmo canvas | alto | médio |
| P2 | Conexões e routing redesenhados | médio/alto | médio |
| P2 | Undo/redo e copy/paste | médio | médio |
| P2 | Groups/subflows | médio | alto |
| P3 | Autoria por linguagem natural | variável | alto |

## 17. Critérios de aceite

### Usuário iniciante

- cria um workflow adapter → agent → ação em menos de 5 minutos;
- não precisa abrir YAML, JSON ou schema;
- conecta nodes visualmente;
- identifica o passo incompleto sem abrir Problems;
- testa com uma entrada real ou fixture;
- entende os efeitos antes de executar/aplicar.

### Usuário avançado

- acessa YAML, schemas, compiled e diff em até um clique;
- consegue inspecionar IDs, policies, contracts e revisions;
- nunca perde alterações ao alternar entre visual e técnico;
- recebe o mesmo resultado canônico independentemente da projeção usada.

### React Flow

- handles funcionam com mouse e teclado;
- conexão inválida é recusada antes da persistência;
- ciclos são bloqueados localmente e confirmados no servidor;
- edge pode ser inserida, removida e reconectada;
- grafo incompleto permanece visível;
- 100 nodes continuam manipuláveis sem atraso perceptível;
- seleção, foco e leitura de estado são acessíveis.

### Arquitetura Luna

- nenhuma decisão de roteamento é delegada a modelo;
- YAML continua canônico;
- servidor continua autoridade de mutação e validação;
- policies de side effects permanecem explícitas;
- adapters continuam normalizando inputs;
- workflows continuam sendo donos da orquestração;
- agents continuam reutilizáveis;
- runtime e provider permanecem desacoplados da UI genérica.

## 18. Métricas de sucesso

- tempo mediano para primeiro workflow executável;
- taxa de conclusão da criação sem abrir modo técnico;
- número de erros por workflow antes do primeiro teste;
- tempo para localizar e corrigir um node inválido;
- percentual de configuração feita pelo mapper versus expressão manual;
- abandono em criação de workflow, agent e execução;
- número de cliques até testar/aplicar;
- frequência de undo e de erros de conexão;
- tempo de render e FPS durante drag;
- satisfação separada entre iniciante e mantenedor.

Meta inicial sugerida: 80% dos workflows comuns devem ser criados usando apenas canvas, inspector básico e painel de teste.

## 19. Riscos e decisões que não devem ser tomadas

- não copiar n8n literalmente: Luna tem invariantes de segurança e determinismo próprios;
- não esconder side effects: traduzi-los e apresentá-los contextualmente;
- não manter o canvas preso ao compiled output;
- não persistir topologia somente no frontend;
- não criar um formato paralelo ao YAML;
- não construir um segundo editor para modo simples;
- não usar drag-and-drop como única forma de adicionar nodes;
- não começar por geração de workflow com IA;
- não tratar alteração cosmética como solução para excesso conceitual.

## 20. Resultado esperado

Ao concluir este plano, o usuário poderá:

1. escolher uma entrada ou adapter;
2. montar o workflow conectando blocos visualmente;
3. criar ou reutilizar agents sem escrever schema manualmente;
4. mapear dados entre nodes por seleção ou drag-and-drop;
5. testar nodes e caminhos antes do run real;
6. acompanhar execução no mesmo grafo usado na autoria;
7. corrigir erros no local em que ocorrem;
8. revisar side effects de forma compreensível;
9. aplicar mudanças com diff e validação autoritativos;
10. acessar todos os detalhes técnicos quando necessário.

O ponto decisivo é este: React Flow deve deixar de representar o resultado da compilação e passar a ser a superfície principal de autoria. O compilador permanece como autoridade, mas trabalha em segundo plano para sustentar a experiência, não para bloqueá-la.

## 21. Estado da implementação

Esta seção separa o que já existe no produto do que ainda depende de um novo contrato autoritativo. A interface não deve simular capacidades que o runtime não oferece.

### 21.1 Entregue

- grafo de autoria derivado do source e visível antes da compilação;
- criação por paleta, busca, drag-and-drop, quick-add e inserção em conexão;
- conexão, remoção e reconexão visual com bloqueio local de ciclos;
- seleção controlada de nodes e edges, handles visíveis e alternativa por outline;
- posições em sidecar, layout ELK vertical/horizontal, nós fixados, minimapa, controles e fit view somente na abertura;
- cards humanos com estado compilado, diagnóstico e execução;
- inspector progressivo, dependências avançadas, comentários e detalhes técnicos recolhidos;
- mapper limitado a dados de passos anteriores, com campos aninhados e tipos de schema clicáveis e arrastáveis, recusando sugestões incompatíveis;
- autosave, validação e compilação em background, com problemas projetados nos nodes;
- teste completo do workflow dentro do canvas usando o mesmo plano e confirmação do Executar;
- “Executar até aqui” autoritativo: o servidor compila o subgrafo com todos os ancestrais do node, recalcula effects e prende o escopo ao snapshot confirmado;
- adapter projetado como trigger a partir das regras determinísticas, sem duplicá-lo no YAML;
- undo, redo, copiar, colar e duplicar com operações semânticas confirmadas pelo servidor;
- criação de workflow por objetivo/template, com nome humano e agents exigidos pelo template;
- catálogo e editor de agents orientados a propósito, permissões, uso, tools e contrato de saída;
- builder de contrato de saída e bancada de teste isolada para agents;
- Blocos separado do Registry técnico, com categorias humanas e índice de consumidores;
- Conexões separada em workflows, routing, adapters e segurança técnica;
- routing descrito em linguagem natural mantendo expressão e ordem first-match como autoridade;
- edição de routing com validação JSONata no servidor, CAS, lock entre processos e substituição atômica durável;
- conexão/provider marcada como verificada somente depois de preview provider-owned bem-sucedido na sessão, sem devolver credenciais;
- configuração agrupada, pesquisável, salva em lote e revisada antes da aplicação;
- lista e detalhe de execuções humanizados, com estado sobre o mesmo componente de grafo;
- forma observada de outputs por node (paths e tipos), limitada e redigida sem valores;
- grupos visuais persistidos no sidecar do canvas, explicitamente sem semântica de execução;
- diagnósticos autoritativos de node e edge projetados diretamente no canvas;
- termos técnicos, IDs, JSON, schemas e políticas mantidos em seções avançadas;
- modo TypeScript estrito no Studio e controladores críticos separados de automação, navegação, layout e apply.

### 21.2 Requer API/BFF/runtime antes da interface

| Capacidade | Autoridade necessária | Motivo para não simular no frontend |
| --- | --- | --- |
| Testar somente um node isolado | plano com fixture explícita para cada dependência e policies próprias | “Executar até aqui” existe, mas um node isolado sem os ancestrais não teria estado válido |
| Executar a partir daqui | checkpoint/fixture autorizado para o estado anterior ao node | iniciar no meio sem estado histórico pode ignorar dependências, gates e side effects |
| Pin de valores de input/output | armazenamento autorizado, redigido e com retenção | a forma observada já expõe somente paths e tipos, nunca os valores |
| Reusar dados de execução | endpoint que autorize e normalize um payload histórico | o catálogo atual expõe metadados, não a invocation privada |
| Comparar duas saídas | snapshots de resultado com schema e política de retenção | artifacts e eventos não equivalem a um output canônico único |
| Groups/subflows executáveis | modelo canônico de composição no workflow YAML e compilador | um retângulo apenas visual daria uma semântica falsa |
| Portas visuais de dados | contrato canônico separado das arestas `after` | o mapper já usa schemas tipados; handles continuam representando dependência de execução |
| Diagnóstico de campo | diagnóstico servidor com `fieldPath` e ação sugerida | node e edge já são autoritativos; inferir o campo pelo índice continuaria frágil |

### 21.3 Ordem segura para concluir os contratos restantes

1. expor snapshots autorizados de execução para fixture, pin de valores e comparação;
2. definir a semântica de node isolado e “a partir daqui” sobre fixtures/checkpoints;
3. definir groups/subflows executáveis no formato canônico, mantendo grupos visuais como mera organização;
4. separar portas visuais de dados das arestas de controle `after`;
5. enriquecer diagnósticos com `fieldPath` e ação sugerida;
6. evoluir o health check de evidência por preview para probes provider-owned dedicados quando cada provider tiver esse contrato.
