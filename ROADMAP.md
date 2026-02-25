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

---

## 🔜 Próximos Passos

### 1. Identificação de Falantes por Animação Visual do Teams
**Prioridade:** Alta
**Status:** Backlog

O Teams indica visualmente quem está falando com uma borda animada/pulsante ao redor do tile de vídeo. A detecção atual via seletores CSS estáticos (`content.js`) é frágil porque o Teams ofusca e muda classes frequentemente.

**Abordagens a investigar:**

#### A) Inspeção profunda do DOM (preferencial)
- Abrir DevTools durante uma chamada e inspecionar o HTML/CSS exato do tile de quem está falando
- Identificar quais atributos, classes ou estilos inline mudam quando alguém fala (ex: `border-color`, `box-shadow`, `animation-name`, classes com hash)
- Implementar detecção baseada em **computed styles** ao invés de seletores estáticos
- Usar `MutationObserver` com foco em atributos de estilo que mudam durante a animação

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

**Pré-requisitos para implementar:**
- [ ] Obter screenshot do Teams durante chamada com alguém falando
- [ ] Inspecionar o DOM (DevTools F12) do tile ativo para mapear atributos relevantes
- [ ] Decidir abordagem (A, B, C ou combinação)
- [ ] Implementar e testar

---

## 📋 Backlog

### 2. Melhorar precisão da transcrição
- Testar modelo `large-v3` vs `large-v3-turbo`
- Avaliar pós-processamento com LLM para correção de nomes próprios
- Implementar vocabulário personalizado (nomes dos participantes como hints)

### 3. Interface de revisão da transcrição
- UI web para revisar e corrigir transcrições geradas
- Edição inline de speaker e texto
- Exportação para DOCX/PDF

### 4. Detecção de conteúdo compartilhado (slides)
- OCR nos frames capturados para extrair texto dos slides
- Vincular conteúdo dos slides aos segmentos de fala correspondentes

### 5. Resumo automático da reunião
- Usar LLM para gerar resumo da transcrição
- Identificar action items e decisões
- Exportar em formato estruturado
