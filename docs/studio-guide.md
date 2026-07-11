# Luna Studio

Luna Studio é a interface local para criar, revisar, aplicar e operar recursos
Luna sem substituir os arquivos, loaders, registries, compiler ou runtime do
projeto. A interface usa React, Vite, Tailwind CSS, shadcn/ui e React Flow; o
servidor de controle usa os mesmos contratos canônicos usados pela CLI.

Em termos objetivos, o Studio permite:

- criar workflows a partir de templates ou do zero;
- editar a DAG, o YAML e os JSON Schemas de um workflow;
- criar e editar agents reutilizáveis;
- executar um smoke isolado de um agent salvo no Test Bench;
- validar e compilar drafts com a implementação real do Luna;
- revisar o diff e aplicar arquivos ao checkout somente após confirmação;
- consultar o histórico Git de workflows e agents e restaurar uma revisão como
  um novo draft;
- visualizar capabilities, registrations e contratos técnicos carregados;
- editar somente campos de configuração de workflow explicitamente expostos;
- simular adapters e o routing determinístico;
- planejar, confirmar e enfileirar uma execução real;
- acompanhar runs, DAG exata, outcome dos nodes, eventos, logs e artifacts.

O Studio não é um formato de workflow novo, um segundo scheduler ou um painel
genérico para editar qualquer arquivo do computador.

## Iniciar localmente

Requisitos:

- Node.js 22.19 ou superior;
- dependências instaladas com `npm install`;
- `config/` válido para o projeto;
- credenciais e repositories configurados quando a operação pretendida chamar
  modelos, providers ou workflows que exigem repository.

Para compilar o backend, gerar o frontend e iniciar a versão servida pelo próprio
Studio:

```bash
npm install
npm run build
npm run studio:build
LUNA_CONFIG_ROOT=config node dist/src/cli.js studio
```

Durante desenvolvimento do backend, também é possível executar a CLI TypeScript
diretamente, mantendo o frontend já compilado em `apps/studio/dist/`:

```bash
npm run studio:build
LUNA_CONFIG_ROOT=config npm run dev -- studio
```

O bind padrão é `127.0.0.1:43110`. O terminal imprime uma URL semelhante a:

```text
Luna Studio: http://127.0.0.1:43110/#capability=<valor-descartavel>
```

Abra a URL completa. A capability no fragmento é trocada uma única vez por uma
sessão local e removida da barra do navegador. Não compartilhe essa URL. Se a
capability for consumida sem que a sessão seja preservada, reinicie o processo e
abra a nova URL impressa.

Opções genéricas do comando:

```text
luna studio [--host <ip>] [--port <porta>]
```

Os flags `--allow-non-loopback-bind`, `--public-host` e `--public-port` existem
para o transporte explícito dentro de container. Eles não transformam o modo
local em um serviço remoto autenticado.

## Iniciar com Docker

Para iniciar somente o Studio e o inicializador de permissões:

```bash
export HOST_UID="$(id -u)"
export HOST_GID="$(id -g)"
export LUNA_STUDIO_CHECKOUT_ID="$(pwd -P | sha256sum | cut -c1-24)"
install -d -m 0700 .runs .luna/studio
docker compose up --build studio
docker compose logs studio
```

Abra a URL `Luna Studio:` exibida no log. O Compose publica apenas
`127.0.0.1:43110:43110`. O processo escuta no wildcard da bridge do container,
mas a autoridade pública, o `Host`, o `Origin` e a porta publicada continuam
presos ao loopback.

O serviço monta:

| Origem no host | Destino | Acesso do Studio |
| --- | --- | --- |
| `.git/` | `/app/.git` | somente leitura, para histórico e comparação |
| `workflows/` | `/app/workflows` | leitura e escrita para apply confirmado |
| `agents/` | `/app/agents` | leitura e escrita para apply confirmado |
| `config/` | `/app/config` | leitura e escrita para configuração autorizada |
| `.luna/studio/` | `/app/.luna/studio` | estado privado de drafts e journals |
| `.runs/` | `/app/.runs` | artifacts, checkpoints, interrupts, logs e snapshots do runtime |
| volume nomeado `luna-<checkout-id>_luna-studio-state` | `/var/lib/luna-studio` | ledger, eventos e catálogo SQLite privados, fora do checkout |
| `LUNA_AUTH_ROOT` | `/app/.luna/auth` | credenciais usadas pelo runtime, nunca projetadas na UI |
| `LUNA_REPOSITORIES_ROOT` | `/repositories` | repositories declarados em `config/repositories.yaml` |

Em Linux nativo, os containers Luna executam com o `HOST_UID:HOST_GID`
obrigatório. `workflows/`, `agents/`, `config/`, `.runs/`, `.luna/studio/` e os
mounts de auth/repositories precisam existir e ser acessíveis por essa
identidade. O inicializador muda, sem recursão, apenas o owner e o modo da raiz
do volume nomeado. Ele nunca executa `chown` ou `chmod` nos bind mounts do
checkout. Um preflight monta `.runs/` e `.luna/studio/` somente para leitura e
exige owner `HOST_UID` e modo `0700`; configuração insegura falha em vez de ser
“corrigida” silenciosamente como root.

`LUNA_STUDIO_CHECKOUT_ID` também é obrigatório no Compose, entra no nome do
projeto e é hashado dentro do state root. Portanto, dois checkouts continuam
isolados mesmo se um override os apontar para o mesmo volume. O exemplo deriva
um id estável do path físico completo; basename não é identidade suficiente.
Fora do container, o catálogo usa `LUNA_STUDIO_STATE_ROOT` ou, por padrão, o
diretório XDG de estado do usuário; cada checkout recebe um subdiretório
identificado por hash. O Studio rejeita um state root configurado dentro do
checkout, mantém o diretório privado em modo `0700` e abre `runs.sqlite` como
arquivo físico regular em modo `0600`, sem seguir um symlink preexistente no
leaf.

O Compose suporta somente clones completos. Em um linked worktree, `.git` é um
gitfile cujo `gitdir` absoluto existe apenas no host; montá-lo em `/app/.git` não
torna a metadata acessível dentro do container. O preflight do Studio rejeita
esse caso explicitamente antes de compor os serviços. Use um clone completo em
vez de esconder a falha de histórico/restore.

Para executar workflows sobre repositories reais no container, os paths de
`config/repositories.yaml` devem usar o namespace do container, por exemplo
`/repositories/meu-repo`. Consulte a seção Docker do [README principal](../README.md)
para os mounts de auth, Git e overrides locais.

## Áreas da interface

### Início

Mostra atalhos para criar workflow, criar agent, abrir o catálogo e preparar uma
execução. Também lista drafts recentes, runs recentes e diagnósticos produzidos
pelo catálogo canônico de workflows.

### Workflows

O catálogo lista os workflows que o loader real conseguiu projetar, incluindo:

- id, mode, número de nodes e concorrência;
- capabilities declaradas;
- input/output schemas e configuração declarada;
- revision técnica;
- drafts locais já associados ao recurso.

É possível abrir um workflow existente em um draft ou criar outro com os
templates versionados atuais:

| Template | Resultado inicial |
| --- | --- |
| `blank-workflow` | estrutura mínima para montar o fluxo do zero |
| `read-only-pipeline` | preflight determinístico e artifact JSON |
| `agent-workflow` | contexto, agent existente e publicação do resultado |
| `parallel-review` | dois reviewers em paralelo e relatório consolidado |
| `gated-repair-loop` | worker em loop de repair com outro agent como gate |
| `human-approval-side-effect` | showcase avançado de aprovação antes de `git.commit`; a retomada ainda exige CLI |
| `context-report` | contexto de repository e relatório Markdown sem chamada de modelo |

Um template gera arquivos Luna normais dentro de um draft. Ele não executa, não
fica ligado à instância criada e não recebe atualizações automáticas quando sua
versão muda. Templates com parâmetros de agent filtram os modes aceitos e
incluem as definições referenciadas na closure do draft.

#### Editor de workflow

O editor tem as seguintes visões:

| Visão | O que permite fazer |
| --- | --- |
| Design | adicionar nodes, selecionar registrations ou agents, editar dependências `after`, inputs, expressions, retry, policies, artifacts, gates e opções avançadas |
| YAML | editar os arquivos YAML do bundle diretamente |
| Schemas | usar builder, árvore ou JSON bruto para schemas e validar uma fixture no servidor sem executar workflow |
| Compiled | inspecionar a projeção devolvida pelo compiler real |
| Diff | comparar base e draft, ver side effects conhecidos e gerar um plano de apply |
| Run | listar as últimas runs desse workflow, comparar a revision compilada atual com a revision executada e abrir o grafo exato |
| Problems | consultar erros e warnings da última validação ou compilação |

No Design:

- o canvas só aparece depois que o compiler aceita a DAG;
- o outline continua navegável por teclado mesmo com fonte ainda inválida;
- arestas representam dependências semânticas de `after`;
- uma dependência que criaria ciclo é bloqueada antes da escrita;
- o layout visual fica no estado lateral do draft e não altera o YAML nem a
  semântica do workflow;
- renomear um node produz uma revisão de impacto para referências conhecidas;
- remover um node é bloqueado enquanto outro node depende dele ou lê seu
  resultado;
- adicionar uma registration também declara a capability proprietária quando
  necessário;
- built-ins com side effect exigem a policy correspondente;
- expressions JSONata podem ser avaliadas no servidor contra fixtures locais
  explicitamente fornecidas;
- o editor avançado continua disponível para estruturas que não cabem nos
  controles genéricos.

Alterações estruturadas são aplicadas pelo servidor ao YAML fonte. Em arquivos
existentes, regiões não editadas, comentários e bytes fora do trecho alterado são
preservados. O YAML completo não é reformatado silenciosamente.

### Agents

O catálogo lista os agents carregados de `agents/<id>/`, com mode, model profile,
tools, output contract, revision e resources declarados. Entradas rejeitadas pelo
loader aparecem como diagnósticos de catálogo parcial, em vez de desaparecerem
atrás de um estado vazio. A busca reversa fica em **Usage & impact** no Agent
Studio e mostra workflows consumidores e agents que usam o recurso como
subagent; quando qualquer catálogo está parcial, a ausência é marcada como
inconclusiva.

Um novo agent começa em um draft com `agent.yaml`, `instructions.md` e
`output.schema.json`. O wizard carrega os ids reais de `config/models.yaml`,
exige a escolha explícita de um model profile e envia esse id ao servidor. O
servidor relê a configuração antes de gerar o YAML; se não houver profile válido
ou a escolha tiver ficado obsoleta, nenhum draft é criado. O Agent Studio oferece
seções estruturadas para:

- **General:** descrição, model profile e mode (`read_only` ou
  `trusted_local_write`);
- **Instructions:** edição, texto literal e preview Markdown sanitizado;
- **Output contract:** schema registrado ou schema próprio, builder/JSON e
  validação de fixture;
- **Resources:** context files, skills, local tools, MCP server ids, subagents,
  requirements e preferências de runtime;
- **Usage & impact:** workflows consumidores e resumo auditável do contrato.

A seleção de tools vem do registry carregado. O Studio mostra compatibilidade de
mode e flags de segurança como escrita local, rede ou efeito externo. Uma tool
desconhecida é preservada, mas não pode ser adicionada de novo sem a registration
correspondente. MCP e subagents são declarações de policy; a materialização ainda
depende do runtime selecionado. No runtime Pi atual, configurar MCP não significa
que ele será executado.

O fallback Raw permite editar os arquivos do bundle diretamente. Alterações
estruturadas e raw não podem ser salvas concorrentemente: a UI exige salvar ou
descartar uma delas primeiro.

#### Test Bench do agent

A aba Test Bench executa um smoke controlado da revisão salva do draft. O target
é preso a `draft_id` e ETag; a aba bloqueia o plano quando há alterações locais,
outra mutação pendente ou uma sessão sem autoridade.

O fluxo é plan-confirm-execute:

1. informe uma fixture JSON e, opcionalmente, contexto JSON explícito;
2. gere o preview efetivo para resolver revision, snapshot, model profile,
   requirements e resources declarados;
3. revise por que a execução está disponível ou bloqueada;
4. confirme que haverá uma chamada real ao modelo;
5. confirme que o escopo é apenas o smoke isolado;
6. execute usando o token curto e descartável do plano.

O smoke faz uma chamada real ao modelo e registra usage/cost quando o runtime os
fornece. Ele testa somente as instructions centrais do agent contra a fixture e o
contexto JSON fornecido. Não executa workflow, local tools, MCP, subagents, skills,
context files do agent, contexto de repository ou contexto implícito de workflow.
Um agent `trusted_local_write` fica bloqueado porque o Test Bench atual não oferece
o isolamento exigido para escrita. Portanto, o resultado não prova que um
workflow completo funcionará nem que suas integrações estão corretas.

Validar um agent não chama modelo. O apply grava os arquivos no projeto, mas não
cria commit ou push.

### Library

Library é a projeção somente leitura do capability registry efetivamente
carregado. É possível buscar e filtrar:

- built-ins;
- patterns;
- tools;
- gates;
- policies;
- ports;
- artifact publishers;
- schemas.

A aba Capabilities permite inspecionar id, versão, kind, dependências, docs,
presets, re-exports, registrations próprias e consumidores. A aba Registrations
diferencia cada categoria e mostra somente os campos técnicos declarados por
aquele tipo, além de exemplos/field hints seguros e consumidores ativos. O índice
reverso informa quando workflows ou agents inválidos tornam o resultado parcial.

A Library é a autoridade da paleta do editor; não existe uma lista paralela de
ids no frontend. Tools e schemas podem ser referenciados por agents ou nodes, mas
não são convertidos automaticamente em nodes de workflow.

### Configuration

Configuration separa quatro superfícies:

1. **Workflow config:** edita somente leaves que o schema do workflow classificou
   com metadata `x-luna-studio`; o YAML bruto e campos não classificados não são
   enviados ao navegador.
2. **Routing:** mostra, em ordem, as regras first-match e seus targets. A edição
   das regras ainda não está exposta na interface.
3. **Input adapters:** lista ids, source, descrição e disponibilidade de
   carregamento/preview dos adapters registrados. Um adapter sem classificação
   completa de efeitos continua disponível na CLI, mas não é carregado pelo
   navegador.
4. **Postura operacional:** mostra projeções redigidas de model profiles,
   repositories, providers, plugins e runtimes.

Config de workflow também usa draft, validação, plano com diff classificado e
confirmação de apply. Secrets, valores brutos de environment, credenciais, URLs
esperadas, opções privadas de runtime e paths absolutos permanecem no servidor.
Repositories, providers, model profiles e plugins são somente leitura nesta
versão.

Comandos externos usados para carregar adapters rodam sem shell implícito, com
environment reduzido, prazo, limites separados de stdout/stderr e cancelamento do
grupo inteiro de processos. Saída acima do limite, JSON/UTF-8 inválido ou processo
órfão falha fechado e não devolve o conteúdo bruto no erro.

### Launch

Launch inicia uma execução real de uma destas formas:

- **adapter:** seleciona um adapter registrado e envia sua string opaca, como uma
  URL de pull request ou task;
- **invocation:** envia diretamente um envelope Invocation JSON válido.

O fluxo é deliberadamente separado:

```text
entrada
  -> adapter opcional produz Invocation
  -> router determinístico escolhe workflow
  -> servidor resolve config, repository, definições e efeitos
  -> plano autoritativo com prazo e hashes
  -> duas confirmações explícitas
  -> revalidação
  -> run enfileirada com run_id prealocado
```

Para adapters que classificam seus efeitos de carregamento, o Studio mostra a
Invocation normalizada e o resultado do routing. A mesma lista exata de efeitos
precisa ser reconhecida antes do preview ou da criação de um plano por adapter;
isso pode incluir leitura de configuração/credencial, rede ou execução de
processo. Esse aceite apenas autoriza carregar o adapter naquela operação:
preview não autoriza executar o workflow e não substitui o plano.

O plano real mostra:

- workflow, mode e revision;
- provenance da entrada;
- hashes da Invocation, configuração, bundle, catálogo e snapshot de execução;
- repository resolvido quando aplicável;
- efeitos potenciais e efeitos resolvidos no preflight;
- incertezas, warnings e validade do token.

A categoria de cada efeito vem do manifesto da policy (`provider_read`,
`local_process`, `repository_write` ou `external_write`), não do nome/id da
capability. Writes sem categoria conhecida aparecem conservadoramente como
`external_write`.

Executar exige marcar que se trata de um run real e que os efeitos e incertezas
foram lidos. O servidor consome o token uma vez, revalida entradas mutáveis e
rejeita plano expirado ou obsoleto. Um workflow pode chamar modelos, tools,
processos, providers e modificar um repository se seu contrato, mode e plano
permitirem.

Se a conexão cair depois do envio e o aceite ficar desconhecido, o Studio exibe
o `plan_id` e abre Runs já com um filtro exato no catálogo. Ausência temporária
nesse filtro não prova rejeição: o operador deve aguardar a reconciliação e não
repetir a execução com a confirmação one-shot consumida.

Quando for necessário reenviar a intenção, o cliente cria e confirma um novo
plano usando a mesma chave de idempotência. Se actor binding e snapshot de
execução continuarem exatos, o dispatcher devolve a run já aceita, vincula o
receipt ao plano novo e preserva no ledger o primeiro plano aceito. Qualquer
mudança relevante impede a adoção.

Um run iniciado que possa escrever não é reexecutado automaticamente após crash
ou perda de confirmação. Sem prova imutável de que o plano inteiro era somente
leitura, ele vai para `outcome_unknown`, preserva workspace/artifacts e exige
inspeção manual. Apenas jobs comprovadamente read-only recebem um recovery intent
durável; o replay exige claim exato desse intent. Checkpoint de node também é
vinculado ao id e à revisão compilada do workflow, então reaproveitar `run_id`
de outra revisão falha antes de executar efeitos.

### Runs

O catálogo de runs é persistido e paginado. Ele pode ser filtrado por status e
pesquisado localmente entre as páginas já carregadas por run id, workflow,
subject ou repository. Um `plan_id` aceito possui filtro canônico no servidor,
usado para investigar uma resposta de dispatch perdida sem repetir a execução.
A tela de detalhe mostra:

- status, falha principal, duração, contagens e completude;
- workflow revision, definition bundle, execution snapshot e repository pinados;
- plan id aceito e provenance segura da entrada (`invocation` ou adapter + hash),
  sem persistir a string opaca entregue ao adapter;
- DAG imutável compilada para aquela execução;
- outcome persistido de cada node, com status e tentativas, quando observável;
- indicação explícita quando graph ou outcome não existe, é legado, parcial,
  inválido ou está indisponível;
- artifacts relacionados a cada node e o node da falha principal;
- timeline ordenada pelo ledger, com SSE e polling como fallback;
- efeitos potenciais/resolvidos e incertezas do preflight persistidos no record;
  essa seção não afirma que um efeito foi realizado;
- logs redigidos, filtráveis por nível e paginados em snapshot;
- artifacts por handles opacos, sem expor paths físicos.

O Studio nunca desenha o workflow atual no lugar do grafo de uma execução antiga.
Se o snapshot exato não estiver disponível, informa a ausência em vez de inferir.
O cursor de logs referencia um snapshot imutável, process-local e com cache
limitado por bytes, entradas e tempo. A origem é lida uma vez por snapshot;
páginas seguintes não reabrem nem recalculam o arquivo completo. Expiração ou
evicção invalida o cursor em vez de voltar silenciosamente ao log mutável.

Runs externos criados pelo CLI ou pelo webhook worker no mesmo artifact root são
reconciliados no startup e periodicamente enquanto o Studio está ativo. Essa
importação é best-effort e estritamente limitada: não segue symlinks, limita
entradas e bytes e lê somente os identificadores mínimos de
`observability-summary.json` ou da primeira linha de `trace.jsonl`. O record
importado usa `dispatch_status: historical_unknown`,
`lifecycle_projection: unknown` e `completeness: legacy`. Ele é imutável e não
inventa outcome terminal, graph, efeitos realizados, contagens ou duração; a API
omite métricas desconhecidas e a UI mostra `Indisponível`. A raiz e cada run são
presas por descritores antes da leitura para que uma troca concorrente por
symlink não atravesse o artifact root confiável. Um diretório inválido ou
inacessível é isolado e não impede o catálogo de continuar disponível.

Artifacts com `semantic_type` conhecido recebem uma view tipada. As views atuais
cobrem findings, cobertura e acceptance de review, publicação em provider,
worktree, plano de implementação, gates, validação, diff, commit, push e change
request. Tipos desconhecidos usam fallback JSON ou texto com redação de paths;
HTML, SVG e binários não são injetados. O botão de download entrega os bytes
originais sem redaction e, por isso, exige o mesmo cuidado de qualquer arquivo
potencialmente sensível ou não confiável.

## Adapter, Invocation, router e workflow

Esta separação é central:

```text
adapter ou Invocation JSON
  -> Invocation normalizada
  -> regras first-match de config/routing.yaml
  -> workflow:<id>
  -> DAG de workflows/<id>/workflow.yaml
```

O adapter entende a entrada física e os detalhes do provider. Por exemplo,
`github-pr-url` pode receber uma URL e produzir uma Invocation com `source`,
`event`, repository e subject. O router avalia somente `{ invocation }`. O
workflow recebe o envelope já normalizado e define nodes, dependências, agents,
gates, retries, policies e artifacts.

Por isso, o workflow não “pertence” a um adapter e `workflow.yaml` não grava
“veio do adapter X”. Uma regra pode dizer que toda Invocation com
`source = "github"` e `event = "pull_request"` vai para `workflow:code-review`,
mas outro adapter que produza o mesmo envelope terá a mesma rota. O mesmo workflow
pode receber GitHub, Jira, Plane, webhook, CLI ou entrada manual.

Se a intenção for forçar um workflow em uma Invocation manual, use o campo
canônico:

```json
{
  "version": "2026-06",
  "source": "studio",
  "event": "manual",
  "target": { "type": "workflow", "id": "example-minimal-agent" },
  "payload": {}
}
```

Isso é um target explícito no envelope, não propriedade do adapter. A tela
Configuration consulta as regras instaladas e Launch simula/explica a decisão;
esta versão não possui editor visual de `routing.yaml`.

## Drafts, validação e apply

Toda alteração de workflow, agent ou configuração começa isolada. Nada é gravado
na fonte canônica ao abrir um editor.

### Persistência e concorrência

Drafts ficam sob `.luna/studio/drafts/` como change sets versionados, com metadata
e blobs endereçados por conteúdo. Eles registram:

- recurso primário e todos os arquivos autorizados;
- hashes e modos da base;
- conteúdo novo ou tombstones;
- dependências e fingerprints de catálogo;
- revisions separadas para record, conteúdo e layout;
- status de validação e layout local.

Cada mutação usa ETag e comparação otimista. Se outra aba, outro processo ou uma
alteração externa mudar a base, a operação falha com conflito em vez de sobrescrever
silenciosamente. Alterações locais não salvas bloqueiam navegação e comandos que
exigem um snapshot persistido.

Trocar uma referência que reduziria o conjunto de arquivos do draft também é uma
operação conflitante quando algum arquivo removido possui edição pendente. Nada é
persistido e a resposta lista, de forma limitada e determinística, os paths que
precisam ser resolvidos; o Studio nunca descarta uma mudança dirty ao recalcular o
bundle autorizado.

### Validate e Compile

Validate monta um snapshot com a fonte atual mais todo o overlay do change set e
chama os loaders e validators reais. Compile executa também o compiler real e
devolve a DAG resolvida. Nenhuma dessas ações executa nodes, chama modelo ou testa
side effects.

Um form válido no navegador não é autoridade. O servidor sempre revalida o
snapshot canônico.

### Diff, plano e apply

O fluxo de escrita é:

1. salvar o draft;
2. validar e, para workflows, compilar;
3. gerar o plano de apply;
4. revisar arquivos, diff, conflitos e side effects projetados;
5. confirmar usando o token curto do plano;
6. o servidor revalida ETag, hashes, dependências e catálogo sob lock;
7. arquivos são instalados e recarregados;
8. o journal registra o resultado durável.

O apply usa chave de idempotência, lock entre processos, staging, backups e journal
crash-recoverable em `.luna/studio/`. Na inicialização, operações incompletas são
verificadas ou revertidas. Se a evidência não permitir concluir com segurança, o
Studio falha a inicialização ou informa `recovery_required`; nunca declara sucesso
por suposição.

O apply só modifica os paths enumerados no change set. Não cria commit, não faz
push e não abre change request. Esses efeitos só podem ocorrer depois, durante um
run real de workflow que os declare e cujo plano tenha sido confirmado.

## Histórico Git

Workflows e agents têm histórico por recurso:

- lista commits alcançáveis pelo branch atual que alteraram o bundle;
- compara qualquer par retornado pelo servidor;
- redige conteúdo sensível no diff projetado;
- cria um draft comum a partir da revisão alvo.

“Restaurar” não move `HEAD`, não atualiza refs, não executa checkout e não escreve
diretamente no projeto. Depois de criar o draft histórico, ainda é necessário
validar, revisar e confirmar o apply. No Docker, `.git` é montado somente leitura.

## Segurança do modo local

O Studio ainda não tem login, identidade de usuário ou RBAC. O controle atual é
adequado apenas para uma pessoa operando um projeto local sob a mesma conta do
sistema operacional.

Mesmo sem autenticação de usuário, o servidor aplica:

- bind público em loopback por padrão;
- capability de inicialização aleatória e descartável;
- cookie de sessão `HttpOnly` e `SameSite=Strict`;
- token anti-CSRF em memória para mutações;
- validação estrita de `Host`, `Origin` e JSON content type;
- CORS fechado e `trustProxy` desabilitado;
- CSP, bloqueio de frames, proteção contra MIME sniffing e limites de body;
- avaliação de routing inteira — em preview, simulação e planejamento de run —
  em um único worker isolado por decisão, com timeout total, limite de memória
  e cancelamento quando a requisição HTTP é encerrada;
- DTOs sem paths absolutos, secrets, environment ou stack traces;
- roots lógicos, rejeição de traversal/symlinks e armazenamento privado;
- nenhuma API arbitrária de arquivo, shell, Git ou environment.

A fronteira de confiança local é o usuário do sistema operacional que possui o
checkout, `.luna/studio/` e o root privado do catálogo. Um processo hostil
executando simultaneamente como o mesmo usuário está fora dessa garantia.
Exposição em rede ou colaboração entre
usuários exige identidade remota, autorização por projeto/repository e auditoria
durável.

Autenticação, RBAC, colaboração e modo remoto são P2. Até essa fase existir, não
publique a porta em `0.0.0.0`, não remova o IP de loopback do Compose e não coloque
o Studio atrás de um proxy público.

## Exemplos objetivos

### Criar um workflow read-only com agent

1. Abra **Workflows > Novo workflow**.
2. Escolha `agent-workflow` e um agent `read_only`.
3. No Design, ajuste dependências, inputs e artifact.
4. Em Schemas, declare a entrada e valide uma fixture.
5. Salve, compile, revise Problems e Diff.
6. Gere e confirme o apply.
7. Em Launch, envie uma Invocation com target explícito ou configure uma regra
   determinística fora do Studio.

Resultado: o projeto recebe um bundle comum em `workflows/<id>/`; a execução
coleta contexto, chama o agent selecionado e publica seu resultado conforme o
template e as alterações revisadas.

### Revisar uma pull request

1. Abra **Launch**.
2. Selecione `github-pr-url` e informe a URL da PR.
3. Execute o preview para ver a Invocation e a rota para `code-review`.
4. Gere o plano e confira repository, revision, effects e warnings.
5. Marque as duas confirmações e execute.
6. Abra a run para acompanhar reviewers, timeline, logs, findings, coverage,
   acceptance e eventual publicação no provider.

Se a configuração de publicação estiver habilitada, o plano precisa expor o
efeito externo. Preview ou Validate não publicam review.

### Montar review paralelo

Use `parallel-review`, selecione dois agents `read_only`, compile a DAG e revise os
dois branches que partem do contexto. O relatório consolidado só executa depois
das duas dependências. É possível trocar os agents ou ajustar os inputs no
inspector antes do apply.

### Testar isoladamente as instructions de um agent

1. Abra ou crie um draft de agent e salve todas as alterações.
2. Abra **Test Bench** e informe uma fixture JSON.
3. Inclua contexto JSON somente se ele fizer parte do caso que deseja avaliar.
4. Gere o preview e confira revision, model profile, requirements e exclusions.
5. Marque as duas confirmações e execute a chamada real.
6. Compare a saída estruturada, usage e custo com o output contract esperado.

Esse teste é útil para ajustar prompt e schema sem executar a DAG. Para validar
tools, MCP, subagents, coleta de contexto, policies ou side effects, ainda é
necessário planejar e executar o workflow real por Launch.

### Montar um loop de implementação

Use `gated-repair-loop`, escolha um worker compatível com
`trusted_local_write` e um reviewer `read_only`. O workflow usa o pattern oficial
de repair e mantém gates no YAML do pattern, não no agent. Para executar de
verdade, o repository precisa estar configurado e o plano de Launch deve mostrar
as permissões e efeitos de escrita.

### Exigir aprovação antes de commit

Use `human-approval-side-effect`. O node `git.commit` nasce no contrato explícito
de skip. Para transformá-lo em commit real, remova `enabled`, `skipped` e
`reason`, forneça `message` e quaisquer constraints necessárias, e revise a
alteração no Diff. Como o Studio ainda não oferece decisão ou retomada de human
gate, Launch rejeita esse workflow antes de criar a run. Para executar esse caso
hoje, use o fluxo de run/`resume` da CLI fora do Studio.

### Gerar relatório sem chamar modelo

Use `context-report`. O fluxo coleta o contexto determinístico do repository e
publica Markdown. O template não contém node agent, mas ainda exige que o
repository e o artifact publisher estejam corretamente configurados.

### Alterar configuração autorizada

Abra **Configuration > Workflow config**, escolha um workflow com `config.file` e
`config.schema`, crie o draft e altere apenas os fields expostos. Valide, revise o
diff classificado e confirme. O Studio grava o arquivo autorizado sem revelar os
outros valores ao navegador e sem reiniciar serviços remotos.

### Recuperar uma definição antiga

Abra o histórico de um workflow ou agent, escolha base e alvo, revise o diff e use
**Criar draft da revisão alvo**. O recurso instalado não muda até o novo draft
passar por Validate, Diff e apply.

## Compatibilidade verificada no P1

O alvo de browser suportado e exercitado automaticamente é o Chromium Desktop
empacotado pelo Playwright. A suíte também executa axe nos fluxos principais e
uma navegação primária por teclado. Firefox, WebKit e validação manual com
screen reader ainda não fazem parte da matriz de release; ausência de violação
automatizada não deve ser apresentada como certificação de acessibilidade.

## Limites atuais

- um processo do Studio opera um único project root e um único config root;
- não há autenticação de usuário, RBAC, multiusuário ou exposição remota segura;
- routing pode ser consultado e simulado, mas não editado na UI;
- repositories, providers, model profiles, plugins, runtime e secrets são
  projeções read-only/redigidas;
- somente fields de config explicitamente classificados podem ser editados;
- não há API genérica para arquivos, terminal, shell, Git ou environment;
- não há cancel, retry, resume ou decisão de human gate na tela de runs;
- runs iniciados pelo Studio ou CLI preservam o worktree após sucesso ou falha;
  a limpeza automática fica desabilitada até existir uma operação própria,
  confirmada, durável, recuperável e visível no estado operacional;
- Validate, Compile, preview de adapter e schema fixture não são dry-run de uma
  execução;
- os efeitos mostrados no plano e no run são a intenção declarada antes do
  dispatch; ainda não existe um ledger genérico de tentativa/resultado para
  cada efeito externo realizado por providers;
- authoring apply não cria commit, push ou change request;
- MCP e subagents dependem do runtime e podem ser rejeitados na execução;
- templates não atualizam recursos já criados;
- o histórico cobre commits alcançáveis no branch atual, não um navegador Git
  completo;
- runs antigas ou parciais podem não ter graph/outcome exato; o Studio explicita
  essa ausência;
- redaction de logs e previews reduz exposição, mas o download de artifact mantém
  os bytes originais;
- a busca textual em Runs filtra as páginas já carregadas; o filtro de status é
  aplicado pelo catálogo no servidor.

## Verificação para mudanças no Studio

Os gates principais são:

```bash
npm run studio:test
npm run studio:lint
npm run studio:build
npm run studio:e2e
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
npm test
npm run build
```

Detalhes de ownership, persistência e segurança estão em
[Luna Studio Architecture Decisions](studio-architecture.md). Os contratos gerais
do runtime continuam documentados em [Workflows and artifacts](workflows-and-artifacts.md),
[Agents, context, and skills](agents-context-and-skills.md),
[Adapters and providers](adapters-and-providers.md) e
[Runtime and observability](runtime-and-observability.md).
