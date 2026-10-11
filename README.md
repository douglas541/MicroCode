# MicroCode

**Um agente de código para o terminal. Ferramentas nativas quando disponíveis; ferramentas por texto quando necessárias.**

O MicroCode lê projetos, busca código, cria e edita arquivos e executa comandos locais. Funciona também com modelos que **não oferecem function/tool calling na API**, como Dolphin Mistral Venice e Cydonia 24B no OpenRouter.

Node.js **22 ou superior**. Sem dependências de runtime. Windows, Linux e macOS. Para desenvolvimento e publicação, use **pnpm 12.10.1**.

## Começar

### Instalação global

```sh
npm install -g @microcode-org/microcode
microcode
```

Execute `microcode` no diretório do projeto que deseja trabalhar, ou informe o caminho:

```sh
microcode --cwd "C:\caminho\do\projeto"
```

Para atualizar:

```sh
npm install -g @microcode-org/microcode@latest
```

### Executar a cópia local

Na pasta deste repositório:

```sh
pnpm install --frozen-lockfile
pnpm start
```

Para usar a cópia local como comando global durante o desenvolvimento:

```sh
npm link
microcode
```

O link acompanha alterações no código sem reinstalar o pacote.

Na primeira execução:

```text
/connect openrouter
/models dolphin
```

Informe sua API key no campo mascarado, use as setas para escolher o modelo e pressione Enter. A chave do OpenRouter é validada com `GET /key` antes de salvar, sem gerar tokens. Também pode definir `OPENROUTER_API_KEY` ou `OPENCODE_API_KEY` no ambiente em vez de salvar uma chave.

```text
/model cognitivecomputations/dolphin-mistral-24b-venice-edition
Leia o projeto, corrija o problema na validação e execute os testes.
```

```text
/model thedrummer/cydonia-24b-v4.1
Crie um script Node.js que agrupe os arquivos deste diretório por extensão.
```

`auto` consulta as capacidades do catálogo e escolhe o modo adequado. Se um endpoint rejeitar ferramentas nativas apesar dos metadados, o agente tenta novamente por texto. Falhas de autenticação e de saldo não acionam esse fallback.

## Providers

| ID            | Serviço      | Base URL                        | Credencial de ambiente |
| ------------- | ------------ | ------------------------------- | ---------------------- |
| `openrouter`  | OpenRouter   | `https://openrouter.ai/api/v1`  | `OPENROUTER_API_KEY`   |
| `opencode`    | OpenCode Zen | `https://opencode.ai/zen/v1`    | `OPENCODE_API_KEY`     |
| `opencode-go` | OpenCode Go  | `https://opencode.ai/zen/go/v1` | `OPENCODE_API_KEY`     |

`/connect` oferece os três presets e uma opção personalizada para APIs OpenAI-compatible, incluindo servidores locais. `/provider add` é um alias para adicionar conexões. OpenRouter valida a chave via `GET /key`; Zen e Go usam `GET /zen/go/v1/usage`, sem inferência. Uma chave Zen válida pode ser autenticada mesmo sem assinatura Go; conectar ao Go exige acesso ao plano.

Providers personalizados podem informar um caminho GET protegido para validação, relativo à base URL, ou usar `/models`. A conexão compara acesso com chave e acesso anônimo: só confirma autenticação se o endpoint rejeitar a consulta anônima. Um catálogo público comprova conectividade, mas não a validade da chave; essa distinção aparece na interface.

No OpenCode, os modelos são roteados para **Chat Completions, Messages, Responses ou Gemini**, conforme os metadados de `models.dev`. O cliente envia `User-Agent: microcode/<versão instalada>` e um `x-opencode-session` estável por conversa. Modelos públicos gratuitos do Zen podem usar a credencial pública; os demais usam sua chave.

### Seleção de modelos

`/models` abre uma lista interativa em tela própria, com pesquisa por nome/ID que filtra os resultados a cada tecla. Cada opção apresenta:

- preço de entrada e saída em **USD por 1 milhão de tokens**;
- suporte a tool calling **nativo**: sim, não ou desconhecido;
- indicação de modo por texto para modelos sem ferramentas nativas;
- janela de contexto e protocolo do endpoint.

Digite diretamente para pesquisar, use **↑/↓** para navegar, **Page Up/Page Down** para rolar e **Enter** para selecionar. **Esc** cancela; **Backspace** edita a busca e **Ctrl+U** limpa o filtro. O modelo destacado mostra seus custos, suporte a tools e janela de contexto. Ao fechar o seletor, o histórico do chat reaparece intacto. Os seletores de providers também usam esse comportamento. Sem um terminal interativo, IDs e filtros podem ser enviados por linhas para automação.

`/models --refresh` atualiza o catálogo. O cache dura uma hora e uma cópia anterior pode ser usada offline, com indicação explícita.

Preço desconhecido aparece como `n/d`, e não como gratuito. Valores do catálogo são referências: tiers de contexto, cache, roteamento e planos podem alterar a cobrança.

## Ferramentas

| Ferramenta   | Uso                                                         |
| ------------ | ----------------------------------------------------------- |
| `read_file`  | Leitura de arquivos UTF-8 com linhas numeradas              |
| `list_files` | Listagem recursiva, filtros glob e exclusão de dependências |
| `search`     | Busca literal ou regex com arquivo e número da linha        |
| `web_search` | Busca na internet com títulos, links e trechos              |
| `web_fetch`  | Leitura de URLs HTTP/HTTPS como Markdown ou texto           |
| `write_file` | Criação/substituição de arquivos                            |
| `edit_file`  | Substituição exata de texto, com verificação de ambiguidade |
| `shell`      | Git, builds, testes e outros comandos locais                |

### Três modos

```text
/tools auto
/tools native
/tools text
```

- **auto**: nativo se o catálogo anuncia suporte; texto em caso contrário ou desconhecido.
- **native**: esquemas de ferramentas enviados no formato próprio do endpoint.
- **text**: nenhum parâmetro nativo `tools` ou `tool_choice` é enviado. As ferramentas são descritas no prompt, e as respostas usam um protocolo textual reservado:

````text
```microcode_tool
{"name":"shell","arguments":{"command":"pnpm test"}}
```
````

O MicroCode valida o JSON, executa a ferramenta local e devolve o resultado ao modelo na próxima etapa. Blocos XML `<tool_call>...</tool_call>` também são reconhecidos. Blocos comuns de código, JSON solto e exemplos dentro de outras fences não são executados. Um lote contendo JSON inválido é rejeitado inteiro e pode ser corrigido pelo modelo.

Os mesmos schemas, permissões e executores são usados nos dois modos, incluindo as ferramentas web e a autorização interativa de diretórios. Modelos sem tool calling continuam precisando seguir o protocolo textual: a qualidade dessa execução depende da capacidade do modelo de gerar JSON válido e acompanhar os resultados.

### Busca e leitura web

`web_search` usa DuckDuckGo HTML, com fallback para Bing RSS quando o primeiro buscador falha ou retorna desafio anti-bot. Não precisa de API key extra. Os resultados trazem título, URL, trecho e o buscador utilizado; páginas bloqueadas não são apresentadas como buscas vazias bem-sucedidas.

`web_fetch` lê páginas HTTP/HTTPS, texto, JSON e XML. HTML é convertido em Markdown/texto legível, preservando títulos, links e blocos de código e removendo scripts/estilos. São seguidos até cinco redirecionamentos, com limite de download de 2 MiB, limite padrão de saída de 20.000 caracteres e timeout. A ferramenta não executa JavaScript nem extrai PDF/imagens.

```text
Pesquise a documentação atual do Node.js e leia a fonte oficial. Cite os links usados.
Leia https://nodejs.org/docs/latest-v24.x/api/fs.html e explique readFile.
```

Argumentos: `web_search` recebe `query`, `limit` (1–10, padrão 5) e `timeout_ms`; `web_fetch` recebe `url`, `format` (`markdown` ou `text`), `max_chars` (até 60.000) e `timeout_ms`. São ferramentas somente leitura, disponíveis também em `/plan`. O conteúdo retornado é marcado como dado externo não confiável; fontes devem ser verificadas e citadas pelo agente.

### Aprovações interativas

Pedidos de edição, comandos e acesso a diretórios aparecem em um **painel compacto dentro do chat**, com prévia da ação e opções numeradas. Edições exibem os trechos propostos; comandos mostram o diretório e o comando.

```text
◇ APROVAR COMANDO
  Diretório: C:\projeto
  $ pnpm test

› 1. Permitir uma vez
  2. Permitir este comando nesta sessão
  3. Negar
```

Use **↑/↓ ou Tab** para escolher e **Enter** para confirmar. Os atalhos **1/2/3** escolhem diretamente, e **Esc** nega. As confirmações de sobrescrita de exportação e `/rewind` também usam menus; nessas ações, cancelar é a opção selecionada inicialmente.

- **Permitir uma vez:** aprova somente aquela chamada.
- **Permitir edições nesta sessão:** libera `write_file` e `edit_file` nos diretórios autorizados. Comandos shell e diretórios externos continuam pedindo sua própria aprovação.
- **Permitir este comando nesta sessão:** libera apenas a string exata do comando no mesmo diretório real. Outro comando, argumentos diferentes ou outro `cwd` exigem nova aprovação.
- **Negar:** informa a recusa ao agente, sem executar a ação.

Autorizações da sessão permanecem ao usar `/resume`. `/permissions` mostra o estado e `/permissions reset` revoga as autorizações da sessão, incluindo diretórios externos, e volta ao modo `ask`.

### Comandos locais

O shell é `cmd.exe` no Windows e `/bin/sh` em sistemas POSIX. Comandos têm timeout configurável por chamada, limite de saída e cancelamento da árvore de processos.

Por padrão, edições e shell pedem confirmação. `/permissions auto` ou `--auto-approve` autorizam essas ferramentas automaticamente. `/plan` disponibiliza somente leitura/listagem/busca. File tools operam no projeto e nos diretórios adicionados com `/add-dir`, verificando escapes por caminhos e symlinks. **Shell executa comandos com as permissões do seu usuário; não é um sandbox.**

### Autorizar diretórios durante a execução

Quando uma ferramenta de arquivos ou o `cwd` de um comando precisa sair dos diretórios autorizados, o agente **pausa e abre um pedido de permissão no chat**, mostrando o diretório real e o alvo. Use as setas/Enter ou os atalhos 1/2/3 para escolher:

- **Permitir apenas esta operação:** o acesso é liberado para aquela ferramenta; acessos futuros solicitam permissão novamente.
- **Permitir durante esta sessão:** o diretório e seus subdiretórios ficam autorizados, inclusive ao retomar a mesma sessão com `/resume`.
- **Negar acesso:** a ferramenta retorna uma negativa ao modelo; pedidos repetidos para o mesmo diretório são bloqueados durante essa execução.

Essa solicitação ocorre também para referências `@arquivo` externas ao projeto e continua ativa em `/permissions auto`. `/add-dir` permanece como opção para autorizar previamente. Links simbólicos são resolvidos para mostrar o destino real, e uma troca do destino não amplia automaticamente a autorização. Esc nega o pedido; Ctrl+C cancela a execução em andamento.

## Comandos

No prompt do chat, digite **`/`** para abrir imediatamente a lista de comandos com suas descrições **acima da linha de digitação**. A lista filtra conforme você digita: `/mod`, por exemplo, mostra `/models` e `/model`. O campo de entrada fica entre separadores, e abrir/fechar as sugestões recalcula a área da conversa sem rolar e apagar o cabeçalho desnecessariamente.

- **↑/↓** navegam pelas sugestões.
- **Tab** completa o comando e deixa espaço para argumentos.
- **Enter** seleciona/executa o comando destacado. Se ele exigir um argumento (`/btw`, `/rename`, `/add-dir`), o cursor permanece no prompt para você escrever esse argumento.
- **Esc** fecha as sugestões.
- Fora do menu, **↑/↓** recuperam pedidos anteriores; a edição de texto e a colagem multilinha continuam disponíveis.

O cabeçalho usa a marca `</> MicroCode`, com versão alinhada e informações do projeto.

Pedidos enviados pelo usuário aparecem em uma faixa cinza com texto claro em negrito e marcador `❯`, separados visualmente das respostas. Mensagens longas e multilinha mantêm o recuo; o mesmo destaque é reaplicado ao retomar sessões e redimensionar o terminal. Em `NO_COLOR` ou saída sem TTY, são usados texto simples e espaçamento.

Durante uma execução com ferramentas, comentários intermediários aparecem como `● comentário`, sem repetir o cabeçalho do agente em cada etapa. Chamadas de ferramentas usam `›`, com resultados recuados em `└`; linhas longas acompanham a largura do terminal. A resposta final mantém o cabeçalho `● MicroCode` e sua formatação Markdown.

| Comando                                             | Função                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------ |
| `/help`                                             | Ajuda completa; Tab completa comandos                                    |
| `/connect [provider]`, `/login`                     | Adicionar provider/API key                                               |
| `/logout [provider]`                                | Remover chave salva                                                      |
| `/provider`, `/provider add`, `/provider remove ID` | Gerenciar providers                                                      |
| `/models [filtro]`, `/model [ID]`                   | Selecionar modelo                                                        |
| `/tools auto\|native\|text`                         | Selecionar protocolo de ferramentas                                      |
| `/status`                                           | Provider, modelo, sessão, tokens, velocidade e custo                     |
| `/cost`                                             | Totais e custos separados entre agente, compactação e perguntas laterais |
| `/context`                                          | Janela estimada, reserva de saída e parâmetros de compactação            |
| `/compact [instruções]`                             | Compactar manualmente o histórico antigo                                 |
| `/btw pergunta`                                     | Pergunta lateral com acesso ao contexto e sem ferramentas                |
| `/clear`                                            | Nova sessão, mantendo a anterior para retomada                           |
| `/resume [ID]`                                      | Retomar uma sessão do projeto                                            |
| `/rename nome`                                      | Renomear a sessão                                                        |
| `/export [arquivo.md]`                              | Exportar conversa para Markdown                                          |
| `/rewind [N\|ID\|list]`, `/undo`                    | Selecionar turnos e restaurar arquivos capturados                        |
| `/init`                                             | Inspecionar localmente e gerar/atualizar `AGENTS.md`                     |
| `/memory [texto]`                                   | Mostrar instruções/notas ou adicionar memória persistente                |
| `/memory add\|edit\|remove\|search\|clear`          | Gerenciar notas de memória do projeto                                    |
| `/plan [on\|off]`                                   | Modo somente leitura                                                     |
| `/permissions ask\|auto`                            | Configurar confirmação de ferramentas                                    |
| `/config [chave valor]`                             | Ver/alterar preferências                                                 |
| `/add-dir caminho`                                  | Autorizar um diretório adicional nas file tools                          |
| `/diff`                                             | Mostrar `git diff`                                                       |
| `/doctor`                                           | Diagnóstico de runtime, ferramentas, memória e todos os providers        |
| `/paste`                                            | Pedido multilinha; finalize com `.end`                                   |
| `/exit`, `/quit`                                    | Sair                                                                     |

`@arquivo` e `@"arquivo com espaços"` anexam conteúdo ao pedido. `!comando` executa shell diretamente. Ctrl+C cancela uma execução em andamento; no prompt ocioso, encerra o programa.

### Instruções locais e memória do projeto

`/init` funciona sem modelo ou conexão: inspeciona a estrutura da raiz, manifestos reconhecidos, scripts de `package.json` e alvos de `Makefile`, e gera um bloco identificado em `AGENTS.md`. Repetir o comando atualiza apenas esse bloco, preservando as instruções manuais ao redor. Comandos encontrados são identificados como **declarados**, sem afirmar que foram executados. A gravação respeita aprovações e modo `plan` e cria um checkpoint.

`/memory` mostra `AGENTS.md`, `MICROCODE.md` e as notas persistentes. As notas são armazenadas em `.microcode/memory.json` dentro do projeto, carregadas nas consultas do agente e perguntas laterais e incluídas na estimativa de contexto, inclusive após `/clear` ou em outra sessão.

```text
/memory add Use o formatter do projeto antes de terminar.
/memory list
/memory search formatter
/memory edit ID_DA_NOTA Prefira alterações pequenas e execute os testes.
/memory remove ID_DA_NOTA
/memory clear
```

`/memory texto` adiciona uma nota sem precisar do subcomando `add`. IDs aparecem na listagem e aceitam prefixos sem ambiguidade. Até 100 notas podem ser salvas, com 4.000 caracteres por nota e 24.000 no total. As alterações respeitam permissões, têm checkpoints e não exigem inferência; `/memory clear` pede confirmação.

### Diagnóstico e Git

`/doctor` verifica Node 22+, pnpm 12.10.1, shell, Git, acesso ao projeto/armazenamento, instruções/memória e autenticação/catálogo de **cada provider**. Falhas são mostradas separadamente e não interrompem as demais verificações. Um catálogo recuperado apenas do cache é identificado como falha de acesso atual, e credenciais não aparecem na saída. O diagnóstico não gera tokens.

`/diff` exibe o diff dos arquivos rastreados pelo Git. Erros, incluindo execução fora de um repositório, são apresentados como falhas; não são confundidos com um projeto sem alterações. A execução suporta cancelamento e desativa pagers/diffs externos.

### Perguntas laterais: `/btw`

```text
/btw Por que você escolheu essa biblioteca?
```

A pergunta usa o contexto atual, mas **não altera o histórico principal nem executa ferramentas**. Sua utilização é contabilizada separadamente em `/cost`. Durante uma inferência, você também pode digitar `/btw pergunta`; o CLI agenda a consulta paralela. A resposta principal e a lateral aparecem com rótulos diferentes.

### Contexto e compactação

O agente compacta automaticamente antes de novas inferências quando a estimativa de contexto chega ao limite configurado. O resumo preserva requisitos, decisões, arquivos, comandos, resultados e pendências; os turnos recentes são mantidos integralmente, inclusive pares de chamadas/resultados.

```text
/config compaction.auto true
/config compaction.threshold 0.80
/config compaction.keepTurns 4
/config compaction.summaryTokens 2048
/compact Preserve os nomes dos arquivos e os testes que falharam.
```

| Configuração                 | Padrão | Significado                                   |
| ---------------------------- | ------ | --------------------------------------------- |
| `compaction.auto`            | `true` | Habilita compactação automática               |
| `compaction.threshold`       | `0.80` | Fração da janela útil que dispara compactação |
| `compaction.keepTurns`       | `4`    | Quantidade de turnos recentes preservados     |
| `compaction.summaryTokens`   | `2048` | Máximo de tokens do resumo                    |
| `compaction.contextOverride` | `null` | Janela manual, se o catálogo não informar     |
| `maxTokens`                  | `8192` | Limite de saída por inferência                |
| `maxSteps`                   | `25`   | Máximo de etapas por pedido                   |

A janela útil desconta a reserva de tokens de saída. Quando necessário, a compactação automática reduz a retenção a um turno para caber na janela. Um único pedido/anexo grande demais precisa ser reduzido. Sem janela informada pelo catálogo, defina `compaction.contextOverride` para habilitar os limites automáticos.

Transcrições grandes são resumidas em segmentos. Se a API falhar ou o resumo não diminuir o tamanho do histórico, o histórico original é preservado. As chamadas de resumo entram nos custos da sessão. A compactação libera contexto na conversa atual; checkpoints antigos que ficaram fora dos turnos preservados deixam de estar disponíveis para `/rewind`.

### Checkpoints

O MicroCode guarda os últimos dez checkpoints, incluindo turnos do agente, edições locais de `/init` e `/memory` e comandos diretos `!`. Além de `write_file` e `edit_file`, comandos shell capturam alterações de arquivos no projeto, nos diretórios autorizados e no `cwd` aprovado: criações, modificações e exclusões, inclusive arquivos binários. Comandos com erro, timeout ou cancelamento também registram as alterações concluídas.

`/rewind` abre um seletor de turnos. O turno escolhido e todos os seguintes são revertidos, com confirmação. `/rewind 1` reverte o último checkpoint, `/rewind 3` reverte os três últimos, `/rewind list` lista os disponíveis e `/rewind ID` aceita um prefixo único. `/undo` oferece o mesmo comportamento. O histórico e os arquivos capturados são restaurados, sem descontar custos; todos os arquivos são validados antes de qualquer restauração, recusando sobrescrita de edições manuais posteriores.

Snapshots de shell têm limites de **1 MiB por arquivo, 16 MiB por varredura e 5.000 entradas**. Não seguem symlinks e excluem `.git`, `.microcode`, `node_modules`, `.next`, `dist`, `build`, `coverage`, `.venv` e `__pycache__`. Cobertura parcial aparece na confirmação de rewind; uma varredura incompleta não inventa snapshots de arquivos ausentes. São restaurados os conteúdos/permissões dos arquivos capturados, não estado Git, diretórios vazios, serviços, bancos de dados ou efeitos fora dos diretórios autorizados. Checkpoints antigos de shell sem snapshots continuam identificados como cobertura legada.

## Métricas

### Barra de status persistente

Em um terminal interativo com espaço disponível, o MicroCode mantém a barra de status **fixa na parte inferior**, com o prompt acima dela. O rodapé ocupa **uma linha em janelas largas e, no máximo, duas nas menores**, usando o nome legível do modelo, modo de trabalho, percentual de contexto, tokens, velocidade e custo. Informações completas, como o ID do modelo/sessão e a janela de contexto em tokens, ficam em `/status`. O suporte a tools nativas aparece no seletor de modelos, não no rodapé. Os valores são atualizados na própria barra durante a geração e após cada resposta, sem adicionar cópias desse bloco à conversa.

O histórico rola na área acima do rodapé. Sugestões de comandos, seletores e menus de aprovação compartilham essa área e preservam a barra. Ao redimensionar, a conversa é redesenhada a partir do texto original na nova largura, e o painel aberto, sua seleção e a digitação são preservados. A barra usa menos linhas em janelas compactas. Ao sair, a região de rolagem normal do terminal é restaurada. Em saída redirecionada/sem TTY ou em janelas extremamente pequenas, é usada a saída textual normal.

### Markdown nas respostas

Respostas do agente e de `/btw` são renderizadas no terminal: títulos destacados, **negrito**, _itálico_, texto riscado, listas numeradas/bullets, tarefas, citações, links com seus destinos, tabelas alinhadas e blocos de código com identificação de linguagem. Os marcadores de Markdown são convertidos em apresentação visual, preservando caracteres literais dentro de código.

Parágrafos e listas respeitam a largura do terminal, mantendo a indentação das continuações. Tabelas estreitas usam uma apresentação vertical quando as colunas não cabem. Blocos de código preservam as linhas e a indentação. Em saídas sem TTY ou com `NO_COLOR`, a estrutura é apresentada como texto legível, sem sequências ANSI.

A formatação é somente visual: a conversa salva e os dados usados nas próximas chamadas continuam contendo o Markdown original.

### Erros e limites de taxa

Em HTTP 429, o MicroCode mostra o provedor original, código e detalhes de `error.metadata.raw` quando disponíveis. A limitação pode vir do OpenRouter ou do serviço que atende o modelo. O cliente realiza até **duas retentativas**, com backoff exponencial e aviso de espera na interface, respeitando `Retry-After` em segundos ou como data HTTP.

```text
/config retry.maxRetries 2
/config retry.baseDelayMs 1500
/config retry.maxDelayMs 60000
```

`retry.maxRetries 0` desabilita retentativas. Esperas indicadas pelo servidor que excedam `retry.maxDelayMs` são informadas e não são encurtadas. Cotas diárias/mensais esgotadas e erros de autenticação/saldo não são repetidos automaticamente. Ctrl+C cancela a espera. Retentativas acontecem apenas para HTTP 429 antes de um stream bem-sucedido; erros depois de iniciar o stream não refazem a inferência automaticamente.

O status identifica chamadas que falharam sem resposta concluída. O último erro é guardado na sessão com detalhes sanitizados, sem credenciais. Tokens/custos só usam respostas concluídas; a velocidade da resposta bem-sucedida exclui espera de backoff e tentativas rejeitadas. Retentativas não reenviam ferramentas já executadas nem adicionam mensagens duplicadas ao histórico. Se o serviço continuar indisponível, aguarde ou escolha outro modelo em `/models`.

A linha de status mostra tokens de entrada/saída acumulados, custo e tokens por segundo. Durante inferências, um indicador exibe tempo e estimativas de geração; a resposta é apresentada após o fechamento do stream, mantendo os blocos de controle fora da interface.

- Contadores reais da API são usados quando disponíveis.
- Na ausência de contadores, tokens são estimados pelo tamanho UTF-8 e identificados por `~`.
- O custo informado pela API tem prioridade; estimativas usam preços de entrada, saída e cache e também recebem `~`.
- TPS = tokens de saída / duração da inferência, incluindo latência inicial e excluindo execução de ferramentas e espera por confirmação.
- A janela de contexto é uma estimativa local, sem tokenizer específico de cada modelo.

## Configuração e sessões

### Retomar uma conversa

`/clear` salva a sessão anterior, cria uma nova e limpa a tela, o scrollback e o cache visual da conversa. Logs de comandos como `/model` e `/connect` deixam de aparecer, inclusive depois de abrir sugestões ou redimensionar o terminal. A interface recomeça com o cabeçalho do projeto, prompt e rodapé; a sessão anterior continua disponível em `/resume`.

`/resume` abre um seletor interativo das sessões deste projeto. Digite para filtrar por título, ID ou modelo, navegue com **↑/↓** e pressione **Enter**. **Esc** cancela a seleção. Cada opção mostra data, modelo e quantidade de perguntas/respostas; todas as sessões armazenadas podem ser pesquisadas.

No seletor, **Delete** exclui a sessão destacada após confirmação. A lista é atualizada sem sair do seletor. A sessão ativa não aparece nessa lista e não pode ser excluída por aí. A exclusão remove a conversa, uso, permissões e checkpoints daquela sessão; o projeto e as demais sessões não são alterados.

Ao retomar, o histórico aparece no chat: suas perguntas, respostas com Markdown formatado e um resumo das ferramentas usadas. Essa exibição não executa novamente comandos/ferramentas nem faz chamadas de inferência. O modelo selecionado, os custos e as permissões da sessão são restaurados, e o ↑ do prompt recupera os pedidos anteriores.

```text
/resume
/resume ID_DA_SESSAO
```

Na inicialização interativa, `microcode --resume` e `microcode --resume ID` também mostram o histórico antes do novo prompt. Em execução `-p`, a conversa é recuperada como contexto para o pedido.

Compactações feitas a partir desta versão preservam as mensagens antigas em um arquivo lógico de histórico dentro da sessão, enquanto o modelo recebe somente o contexto reduzido. A exportação também inclui as mensagens arquivadas. Sessões antigas que já perderam mensagens por compactação mostram o resumo disponível em vez de inventar o conteúdo anterior.

Os dados ficam em `~/.microcode/`, ou no caminho definido por `MICROCODE_HOME`:

```text
config.json        Providers, modelo selecionado, modos e compactação
auth.json          API keys salvas localmente
catalogs/          Cache público de modelos
sessions/          Conversas, uso e checkpoints de arquivos
```

Ao colar uma chave em `/connect`, essa chave salva é escolhida explicitamente para o provider. Ao pressionar Enter com uma variável de ambiente definida, o provider usa essa variável. Conexões anteriores sem preferência explícita continuam priorizando o ambiente. `/doctor` mostra a origem da credencial e verifica os providers por consultas GET, distinguindo autenticação confirmada de acesso público, sem fazer inferência.

O campo de chave exibe uma máscara e a quantidade de caracteres, nunca a chave. Prefixo `Bearer`, aspas externas e repetições **idênticas e completas** de uma chave OpenRouter são normalizados; uma chave rejeitada não substitui a credencial anterior. `User not found`/HTTP 401 indica autenticação recusada; use `/connect openrouter` com uma chave válida de [OpenRouter Keys](https://openrouter.ai/settings/keys).

Chaves salvas não entram em prompts nem em exportações. `auth.json` é armazenamento local em JSON, não um cofre criptografado; você pode usar somente variáveis de ambiente. Sessões e checkpoints contêm o conteúdo de arquivos acessados/editados. No projeto, `AGENTS.md`, `MICROCODE.md` e as notas de `.microcode/memory.json` são carregados como instruções.

## Execução não interativa

```sh
microcode --provider openrouter --model thedrummer/cydonia-24b-v4.1 --tools text -p "Analise este projeto"
microcode --resume
microcode --resume ID_DA_SESSAO
microcode --auto-approve -p "Corrija os testes e execute a suíte"
```

## Desenvolvimento

```sh
pnpm check
pnpm test
```

Os testes usam o test runner do Node, servidores HTTP locais e ferramentas reais de filesystem/shell. Cobrem SSE fragmentado, os quatro protocolos, ferramentas por texto, fallback, permissões, cancelamento, sessões, CLI, `/btw`, cache e compactação. Não exigem credenciais nem chamadas pagas.

Referências dos providers: [OpenRouter](https://openrouter.ai/docs), [OpenCode Zen](https://opencode.ai/docs/zen), [OpenCode Go](https://opencode.ai/docs/go), [models.dev](https://models.dev).

## Publicação no npm

O pacote é **`@microcode-org/microcode`** e instala o comando **`microcode`**. A versão inicial é **`0.1.0`**. A conta que publica precisa ter permissão na organização npm **`microcode-org`**.

Na pasta deste repositório, com Node.js 22+ e pnpm 12.10.1:

```sh
pnpm install --frozen-lockfile
npm pack --dry-run
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm publish
```

`publishConfig` define o registro oficial do npm e acesso público. Antes de publicar, o hook `prepublishOnly` executa **`pnpm check` e `pnpm test`**; uma falha interrompe a publicação. Complete a autenticação/2FA solicitada pelo npm.

O campo `files` limita o pacote a `bin/`, `src/`, `README.md` e `LICENSE`; o npm também inclui `package.json`. Confira a listagem de `npm pack --dry-run` antes de cada publicação. O empacotamento usa os arquivos locais, inclusive alterações ainda sem commit. Não inclui `.git/`, testes, `.env` ou `.microcode/` com a configuração atual. As credenciais salvas em `~/.microcode/auth.json` ficam fora do pacote.

Após publicar, confira a versão disponível:

```sh
npm view @microcode-org/microcode version --registry=https://registry.npmjs.org/
```

Para uma nova publicação manual, aumente `version` em `package.json` (por exemplo, para `0.1.1`). A versão exibida no terminal e nos headers HTTP é lida desse manifesto. Uma combinação de nome e versão já publicada não pode ser reutilizada. Repita a conferência do pacote e `npm publish`.

### Publicação automática na main

O workflow [`.github/workflows/publish.yml`](.github/workflows/publish.yml) é disparado por pushes na **`main`**, incluindo merges de pull requests. Também pode ser iniciado por **Actions → Publish MicroCode → Run workflow**, selecionando a `main`.

Antes de publicar, ele reutiliza a matriz de verificações em Windows, Linux e macOS com Node.js 22 e 24. O job de publicação usa Node.js 24, npm 11 com suporte a OIDC e pnpm 12.10.1. O hook `prepublishOnly` também verifica a cópia preparada para publicação.

Cada execução consulta as versões estáveis existentes no registro e incrementa o **patch** da maior versão publicada: `0.1.0 → 0.1.1 → 0.1.2`. Se o manifesto solicitar uma versão maior, como `0.2.0`, ela é utilizada. Sem versões estáveis publicadas, usa a versão do manifesto. Falhas na consulta ao registro interrompem o processo. A versão automática muda apenas na cópia de trabalho do runner; não gera commits nem pushes de versão no repositório. Execuções de publicação são serializadas para evitar colisões de versão; `queue: max` mantém até 100 execuções pendentes sem substituir uma pendente a cada novo push.

#### Configuração inicial no npm

1. Conclua a primeira publicação de `@microcode-org/microcode` pelo terminal, seguindo os passos acima e confirmando o 2FA. O pacote precisa existir para acessar suas configurações de Trusted Publishing.
2. Envie o workflow para o repositório GitHub. Em **npm → @microcode-org/microcode → Settings → Trusted Publisher**, selecione **GitHub Actions** e preencha:

   | Campo                | Valor                                                 |
   | -------------------- | ----------------------------------------------------- |
   | Organization or user | `douglas541`                                          |
   | Repository           | `MicroCode`                                           |
   | Workflow filename    | `publish.yml`                                         |
   | Environment name     | Deixe vazio; o workflow não define environment        |
   | Allowed actions      | Habilite **Allow npm publish** para publicação direta |

   O primeiro campo é o dono do repositório **GitHub**, não a organização npm `microcode-org`. O nome do workflow deve conter apenas `publish.yml`, sem o caminho `.github/workflows/`.

3. Salve e execute o workflow na `main` para validar a conexão. Segundo o npm, uma nova configuração de Trusted Publisher precisa realizar sua primeira publicação em até **dois dias**; se expirar, recrie a configuração.

O GitHub fornece um token OIDC temporário por execução. Não é necessário cadastrar `NPM_TOKEN` nos secrets do repositório nem confirmar 2FA durante cada publicação automática. Referência: [Trusted Publishing do npm](https://docs.npmjs.com/trusted-publishers).

## Licença

MIT.
