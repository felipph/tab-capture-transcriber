# Roadmap — Teams Capture Pro

## ✅ Concluído

- [x] Gravação de áudio/vídeo via `tabCapture`
- [x] Envio de chunks via WebSocket para backend
- [x] Transcrição automática com Whisper
- [x] Screenshots manuais e automáticos
- [x] Detecção de chamada ativa no Teams
- [x] Extração de lista de participantes (DOM)
- [x] Backend com timeline, speaker_map e transcrição estruturada
- [x] Re-transcrição de sessões anteriores
- [x] Transcrição em tempo real com `faster-whisper` (live transcription)
- [x] Captura automática de conteúdo compartilhado (frames → backend)
- [x] Detecção de falante via `data-is-speaking` (abordagem A)
- [x] Detecção de compartilhamento via `data-stream-type="ScreenSharing"`
- [x] Extração de participantes dos tiles de vídeo (não depende do roster aberto)

---

## 🔜 Próximos Passos

### 1. Identificação de Falantes por Animação Visual do Teams
**Prioridade:** Alta
**Status:** ✅ Implementado (Abordagem A)

O Teams indica visualmente quem está falando com uma borda animada/pulsante ao redor do tile de vídeo.

**Abordagem implementada: A) Inspeção do DOM**
- Descoberto atributo estável `data-is-speaking="true"` nos tiles de vídeo (`data-cid="calling-participant-stream"`)
- Nome extraído do `aria-label` do tile (ex: "Yargo Gagliardi, O vídeo está passando, ...")
- E-mail extraído do `data-tid` (ex: "yargo.gagliardi@nuclea.com.br")
- `MutationObserver` atualizado com `data-is-speaking` no `attributeFilter`
- Fallbacks mantidos: seletores de roster e CSS classes

**Pré-requisitos (concluídos):**
- [x] Obter screenshot do Teams durante chamada com alguém falando
- [x] Inspecionar o DOM (DevTools F12) do tile ativo para mapear atributos relevantes
- [x] Decidir abordagem → **A) DOM inspection** com `data-is-speaking`
- [x] Implementar e testar

**Abordagens alternativas (para referência futura):**

#### B) Análise de pixels via Canvas (fallback visual)
- Capturar periodicamente o conteúdo da aba via `captureVisibleTab`
- Analisar as bordas dos tiles de vídeo para detectar a cor/animação indicativa de fala
- Correlacionar a posição do tile com o nome do participante
- Mais robusto contra mudanças de DOM, mas mais pesado computacionalmente

#### C) Diarização de áudio no backend (complementar)
- Usar bibliotecas como `pyannote-audio` ou `resemblyzer` para speaker diarization
- Não depende do DOM — funciona com qualquer fonte de áudio
- Pode ser combinado com a detecção visual para maior precisão
- Requer mais recursos computacionais (GPU recomendada)

---

## 📋 Backlog

### 1. Detecção de conteúdo compartilhado (slides)
- OCR nos frames capturados para extrair texto dos slides
- Vincular conteúdo dos slides aos segmentos de fala correspondentes

### 2. Resumo automático da reunião
- Usar LLM para gerar resumo da transcrição
- Identificar action items e decisões
- Exportar em formato estruturado
