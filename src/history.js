export function isContextSummary(message) {
  return (
    message.role === "user" &&
    message.internal === true &&
    message.content?.startsWith("MICROCODE_CONTEXT_SUMMARY\n")
  );
}

export function conversationMessages(session) {
  const archived = Array.isArray(session.archivedMessages)
    ? session.archivedMessages
    : [];
  const current = session.messages || [];
  return [
    ...archived,
    ...current.filter(
      (message) => !archived.length || !isContextSummary(message),
    ),
  ];
}

// Archive the part removed from the model's context so resume can replay the
// original conversation. Retain a legacy summary if older originals are absent.
export function archiveMessages(session, older) {
  const existing = Array.isArray(session.archivedMessages)
    ? session.archivedMessages
    : null;
  const additions = older.filter(
    (message) => !isContextSummary(message) || existing === null,
  );
  session.archivedMessages = [
    ...(existing || []),
    ...structuredClone(additions),
  ];
}

export function historyQuestions(session) {
  return conversationMessages(session)
    .filter(
      (message) =>
        message.role === "user" && !message.internal && message.content?.trim(),
    )
    .map((message) => message.content)
    .reverse()
    .slice(0, 1000);
}

export function sessionDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })
    : "data indisponível";
}

export function sessionOption(session) {
  const messages = conversationMessages(session);
  const questions = messages.filter(
    (message) => message.role === "user" && !message.internal,
  );
  const responses = messages.filter(
    (message) => message.role === "assistant" && message.content?.trim(),
  );
  const model = session.selected?.model || "modelo não selecionado";
  const date = sessionDate(session.updatedAt);
  return {
    value: session.id,
    label: `${session.title || "Nova sessão"} · ${date}`,
    search: `${session.title || ""} ${session.id} ${model} ${session.selected?.provider || ""} ${date}`,
    details: [
      `ID: ${session.id}`,
      `Modelo: ${model}`,
      `${questions.length} perguntas · ${responses.length} respostas`,
      `Atualizada: ${date}`,
    ],
  };
}
