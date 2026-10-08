# MicroCode

**Um agente de código para o terminal. Ferramentas nativas quando disponíveis; ferramentas por texto quando necessárias.**

O MicroCode lê projetos, busca código, cria e edita arquivos e executa comandos locais. Funciona também com modelos que **não oferecem function/tool calling na API**, como Dolphin Mistral Venice e Cydonia 24B no OpenRouter.

Node.js **22 ou superior** e **pnpm 12.10.1**. Sem dependências de runtime. Windows, Linux e macOS.

## Começar

No diretório do projeto:

```sh
pnpm install
pnpm start
```

Para disponibilizar o comando `microcode` em outros projetos:

```sh
pnpm add -g .
microcode --cwd "C:\caminho\do\projeto"
```

Na primeira execução:

```text
/connect openrouter
/models dolphin
```

Informe sua API key no prompt oculto, selecione o número ou o ID completo do modelo e escreva seu pedido. Também pode definir `OPENROUTER_API_KEY` ou `OPENCODE_API_KEY` no ambiente em vez de salvar uma chave.

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

`/connect` oferece os três presets e uma opção personalizada para APIs OpenAI-compatible, incluindo servidores locais. `/provider add` é um alias para adicionar conexões.

No OpenCode, os modelos são roteados para **Chat Completions, Messages, Responses ou Gemini**, conforme os metadados de `models.dev`. O cliente envia `User-Agent: microcode/0.1.0` e um `x-opencode-session` estável por conversa. Modelos públicos gratuitos do Zen podem usar a credencial pública; os demais usam sua chave.

### Seleção de modelos

`/models` é um seletor paginado, com pesquisa por nome/ID. Cada opção apresenta:

- preço de entrada e saída em **USD por 1 milhão de tokens**;
- suporte a tool calling **nativo**: sim, não ou desconhecido;
- indicação de modo por texto para modelos sem ferramentas nativas;
- janela de contexto e protocolo do endpoint.

Use `n` / `p` para navegar, `/termo` para pesquisar, número/ID para selecionar e Enter para cancelar. `/models --refresh` atualiza o catálogo. O cache dura uma hora e uma cópia anterior pode ser usada offline, com indicação explícita.

Preço desconhecido aparece como `n/d`, e não como gratuito. Valores do catálogo são referências: tiers de contexto, cache, roteamento e planos podem alterar a cobrança.

## Ferramentas

| Ferramenta   | Uso                                                         |
| ------------ | ----------------------------------------------------------- |
| `read_file`  | Leitura de arquivos UTF-8 com linhas numeradas              |
| `list_files` | Listagem recursiva, filtros glob e exclusão de dependências |
| `search`     | Busca literal ou regex com arquivo e número da linha        |
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

Os mesmos schemas, permissões e executores são usados nos dois modos. Modelos sem tool calling continuam precisando seguir o protocolo textual: a qualidade dessa execução depende da capacidade do modelo de gerar JSON válido e acompanhar os resultados.

### Execução local

O shell é `cmd.exe` no Windows e `/bin/sh` em sistemas POSIX. Comandos têm timeout configurável por chamada, limite de saída e cancelamento da árvore de processos.

Por padrão, edições e shell pedem confirmação. `/permissions auto` ou `--auto-approve` autorizam essas ferramentas automaticamente. `/plan` disponibiliza somente leitura/listagem/busca. File tools operam no projeto e nos diretórios adicionados com `/add-dir`, verificando escapes por caminhos e symlinks. **Shell executa comandos com as permissões do seu usuário; não é um sandbox.**

## Comandos

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
| `/rewind`, `/undo`                                  | Reverter o último turno e suas edições via file tools                    |
| `/init`                                             | Pedir ao agente que inspecione o projeto e gere `AGENTS.md`              |
| `/memory [instruções]`                              | Mostrar ou atualizar `AGENTS.md`                                         |
| `/plan [on\|off]`                                   | Modo somente leitura                                                     |
| `/permissions ask\|auto`                            | Configurar confirmação de ferramentas                                    |
| `/config [chave valor]`                             | Ver/alterar preferências                                                 |
| `/add-dir caminho`                                  | Autorizar um diretório adicional nas file tools                          |
| `/diff`                                             | Mostrar `git diff`                                                       |
| `/doctor`                                           | Diagnóstico de runtime, conexão e catálogo                               |
| `/paste`                                            | Pedido multilinha; finalize com `.end`                                   |
| `/exit`, `/quit`                                    | Sair                                                                     |

`@arquivo` e `@"arquivo com espaços"` anexam conteúdo ao pedido. `!comando` executa shell diretamente. Ctrl+C cancela uma execução em andamento; no prompt ocioso, encerra o programa.

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

O MicroCode guarda os últimos dez turnos com snapshots das edições via `write_file` e `edit_file`. `/rewind` restaura esses arquivos e remove o turno do histórico, sem descontar custos já incorridos. Se houver edição manual posterior, o rewind é recusado para preservar seu trabalho. Alterações feitas via shell não são restauradas pelos snapshots.

## Métricas

A linha de status mostra tokens de entrada/saída acumulados, custo e tokens por segundo. Durante inferências, um indicador exibe tempo e estimativas de geração; a resposta é apresentada após o fechamento do stream, mantendo os blocos de controle fora da interface.

- Contadores reais da API são usados quando disponíveis.
- Na ausência de contadores, tokens são estimados pelo tamanho UTF-8 e identificados por `~`.
- O custo informado pela API tem prioridade; estimativas usam preços de entrada, saída e cache e também recebem `~`.
- TPS = tokens de saída / duração da inferência, incluindo latência inicial e excluindo execução de ferramentas e espera por confirmação.
- A janela de contexto é uma estimativa local, sem tokenizer específico de cada modelo.

## Configuração e sessões

Os dados ficam em `~/.microcode/`, ou no caminho definido por `MICROCODE_HOME`:

```text
config.json        Providers, modelo selecionado, modos e compactação
auth.json          API keys salvas localmente
catalogs/          Cache público de modelos
sessions/          Conversas, uso e checkpoints de arquivos
```

Chaves em variáveis de ambiente têm prioridade sobre `auth.json`. Chaves salvas não entram em prompts nem em exportações. `auth.json` é armazenamento local em JSON, não um cofre criptografado; você pode usar somente variáveis de ambiente. Sessões e checkpoints contêm o conteúdo de arquivos acessados/editados. No projeto, `AGENTS.md` e `MICROCODE.md` são carregados como instruções.

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

## Licença

MIT.
