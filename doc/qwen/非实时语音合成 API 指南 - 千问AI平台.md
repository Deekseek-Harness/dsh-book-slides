---
source: https://platform.qianwenai.com/docs/developer-guides/speech/tts#%E6%94%AF%E6%8C%81%E6%A8%A1%E5%9E%8B
created: 2026-11-03
description: 通过 HTTP 将完整文本转换为语音，了解模型特性、快速调用方法和合成效果优化方式。
tags:
  - clippings
---
通过 HTTP 将完整文本转换为语音，了解模型特性、快速调用方法和合成效果优化方式。

## 功能介绍

非实时语音合成通过 HTTP 一次提交完整文本，支持非流式和 SSE 流式输出。非流式返回的音频 URL 有效期为 24 小时，请及时下载保存；链接过期后可重新合成。流式输出逐段返回音频数据。

- **多语言与方言** ：根据目标语言选择模型和音色，也可通过指令指定方言。参见 [方言](https://platform.qianwenai.com/docs/developer-guides/speech/tts#%E6%96%B9%E8%A8%80) 。
- **表现力控制** ：通过自然语言指令调整语速、情感等表达，或在文本中插入情感与富语言标签。参见 [指令控制](https://platform.qianwenai.com/docs/developer-guides/speech/tts#%E6%8C%87%E4%BB%A4%E6%8E%A7%E5%88%B6) 和 [情感与富语言标签](https://platform.qianwenai.com/docs/developer-guides/speech/tts#%E6%83%85%E6%84%9F%E4%B8%8E%E5%AF%8C%E8%AF%AD%E8%A8%80%E6%A0%87%E7%AD%BE) 。
- **自定义音色** ：通过 [声音复刻](https://platform.qianwenai.com/docs/developer-guides/speech/voice-cloning) 从音频样本创建音色，或通过 [声音设计](https://platform.qianwenai.com/docs/developer-guides/speech/voice-design) 使用文字描述创建音色。
- **精细控制与公式朗读** ：使用 [SSML 与 LaTeX](https://platform.qianwenai.com/docs/developer-guides/speech/ssml) 控制停顿、发音等效果，或将公式转换为语音。

- 各模型及音色支持的能力有所不同，使用前请核对对应功能的支持范围。
- 需要分批输入文本时，请使用 [实时语音合成](https://platform.qianwenai.com/docs/developer-guides/speech/realtime-streaming) 。

## 开始使用

- [获取 API Key](https://platform.qianwenai.com/docs/api-reference/preparation/api-key) 并 [配置到环境变量](https://platform.qianwenai.com/docs/api-reference/preparation/export-api-key-env) `DASHSCOPE_API_KEY` 。
- 安装示例依赖：

```bash
pip install requests
```

以下使用 `qwen-audio-3.1-tts-flash` 和系统音色 `longanhuan_v3.1` ，演示非流式和流式输出。

```python
import os
import requests

response = requests.post(
  'https://maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer',
  headers={"Authorization": f"Bearer {os.environ['DASHSCOPE_API_KEY']}"},
  json={
    "model": "qwen-audio-3.1-tts-flash",
    "input": {
      "text": "你好，欢迎使用千问AI平台。",
      "voice": "longanhuan_v3.1",
      "format": "wav",
      "sample_rate": 24000
    }
  },
  timeout=60,
)
response.raise_for_status()
audio_url = response.json()["output"]["audio"]["url"]
audio_response = requests.get(audio_url, timeout=60)
audio_response.raise_for_status()
with open("output.wav", "wb") as f:
  f.write(audio_response.content)
```

运行后，音频保存在当前目录的 `output.wav` 文件中。

## 合成效果优化

### 语言与发音

数字、缩写或符号的读法不符合预期时，可通过 `language_hints` 指定合成目标语言，或通过 `hot_fix` 定义词语发音与文本替换。参数适用模型和配置方法请参见对应的 [Qwen-Audio-TTS API](https://platform.qianwenai.com/docs/api-reference/speech-synthesis/qwen-audio-tts/http-api) 或 [CosyVoice API](https://platform.qianwenai.com/docs/api-reference/speech-synthesis/cosyvoice-nrt/http-api) 。

需要控制停顿、数字读法或字词发音时，可使用 SSML。Qwen-Audio-TTS 和 CosyVoice 的适用模型、音色、接口与标签用法，请参见 [SSML 与 LaTeX](https://platform.qianwenai.com/docs/developer-guides/speech/ssml) 。

### 指令控制

在请求的 `input` 中增加 `instruction` ，用自然语言说明要合成的语种，描述语速、情感或说话方式，控制合成语音的表现。

如需创建具有特定性别、年龄或音色特质的新音色，或参考声音描述的编写建议与示例，请参见 [声音设计](https://platform.qianwenai.com/docs/developer-guides/speech/voice-design) 。

`qwen-audio-3.1-tts-plus` 、 `qwen-audio-3.1-tts-flash` 、 `qwen-audio-3.0-tts-plus` 、 `qwen-audio-3.0-tts-flash` 的系统音色、复刻音色和设计音色均支持在合成请求中通过 `instruction` 设置自然语言指令。

建议在 `instruction` 中说明合成语种和所需效果，以提升合成质量。指令中指定的语种须与待合成文本的语种一致。例如，合成荷兰语文本时，可设置：

```json
{"instruction": "请用荷兰话说，每个字都慢慢说"}
```

MiniMax 通过 `input.voice_setting.speed` 、 `pitch` 和 `emotion` 设置语速、音调和情感，具体取值请参见 [API 参考](https://platform.qianwenai.com/docs/api-reference/speech-synthesis/minimax-tts) 。

### 方言

通过方言功能，可将文本合成为河南话、四川话等中文方言语音。方言的选择方式取决于模型和音色类型。

- **系统音色** ：从 [Qwen-Audio-TTS 音色列表](https://platform.qianwenai.com/docs/developer-guides/speech/voice-list/qwen-audio-tts) 中选择支持目标方言的音色。直接支持该方言的音色无需额外设置；支持方言指令的音色使用 `instruction` 指定。
- **复刻音色** ：通过 `instruction` 指定方言，例如 `请用河南话表达。` 。
- **设计音色** ：暂不支持方言。

对于支持方言指令的音色，在请求的 `input` 中设置 `instruction="请讲上海话。"` ，可将中文文本合成为上海话。

Qwen3-TTS 使用支持目标方言的系统音色，参见 [Qwen3-TTS 音色列表](https://platform.qianwenai.com/docs/developer-guides/speech/voice-list/qwen-tts#qwen3-tts%E9%9D%9E%E5%AE%9E%E6%97%B6%E8%AF%AD%E9%9F%B3%E5%90%88%E6%88%90%E9%9F%B3%E8%89%B2%E5%88%97%E8%A1%A8) 。

### 情感与富语言标签

适用于 `qwen-audio-3.1-tts-plus` 、 `qwen-audio-3.1-tts-flash` 、 `qwen-audio-3.0-tts-plus` 和 `qwen-audio-3.0-tts-flash` 。

情感与富语言标签可控制语音的情感和风格，并在指定位置加入笑声、叹息等拟声效果。将标签直接写入待合成文本 `text` ，无需额外参数。

#### 使用示例

以下文本先使用兴奋语气，在指定位置插入笑声后继续合成正文：

```text
[excited]今天的天气真不错！[laughing]我们一起出去玩吧！
```

以下文本在第二句切换为兴奋语气：

```text
[serious]请注意安全事项。[excited]好了，现在让我们开始吧！
```

#### 支持标签

控制类标签设置后续文本的情感或风格，直到出现下一个控制类标签；长句被自动切分时，作用范围以切分后的文本为界。

| **标签** | **说明** |
| --- | --- |
| `[sad]` | 悲伤 |
| `[amazed]` | 惊叹 |
| `[deep and loud shouting]` | 深沉大声呐喊 |
| `[trembling]` | 颤抖 |
| `[angry]` | 愤怒 |
| `[excited]` | 兴奋 |
| `[sarcastic]` | 讽刺 |
| `[curious]` | 好奇 |
| `[like dracula]` | 吸血鬼语气 |
| `[bored]` | 无聊 |
| `[tired]` | 疲倦 |
| `[scornful]` | 轻蔑 |
| `[shouting]` | 大喊 |
| `[asmr]` | ASMR 轻声 |
| `[panicked]` | 惊慌 |
| `[mischievously]` | 调皮 |
| `[empathetic]` | 共情 |
| `[whispers]` | 低声耳语 |
| `[reluctantly]` | 不情愿 |
| `[crying]` | 哭泣 |
| `[serious]` | 严肃 |
| `[very slowly]` | 非常缓慢 |
| `[very fast]` | 非常快速 |

## 支持模型

- **Qwen-Audio-TTS** ： `qwen-audio-3.1-tts-plus` 、 `qwen-audio-3.1-tts-flash` 、 `qwen-audio-3.0-tts-plus` 、 `qwen-audio-3.0-tts-flash`
- **CosyVoice** ： `cosyvoice-v3.5-plus` 、 `cosyvoice-v3.5-flash` 、 `cosyvoice-v3-plus` 、 `cosyvoice-v3-flash` 、 `cosyvoice-v2`
- **Qwen3-TTS** ： `qwen3-tts-flash`
- **MiniMax** ： `MiniMax/speech-2.8-hd` 、 `MiniMax/speech-02-hd` 、 `MiniMax/speech-2.8-turbo` 、 `MiniMax/speech-02-turbo`

系统音色与试听分别参见 [Qwen-Audio-TTS](https://platform.qianwenai.com/docs/developer-guides/speech/voice-list/qwen-audio-tts) 、 [CosyVoice](https://platform.qianwenai.com/docs/developer-guides/speech/voice-list/cosyvoice) 和 [Qwen3-TTS](https://platform.qianwenai.com/docs/developer-guides/speech/voice-list/qwen-tts#qwen3-tts%E9%9D%9E%E5%AE%9E%E6%97%B6%E8%AF%AD%E9%9F%B3%E5%90%88%E6%88%90%E9%9F%B3%E8%89%B2%E5%88%97%E8%A1%A8) 音色列表。使用复刻或设计音色时，合成模型须与创建音色时指定的目标模型一致。

## API 参考

- [Qwen-Audio-TTS HTTP API](https://platform.qianwenai.com/docs/api-reference/speech-synthesis/qwen-audio-tts/http-api)
- [CosyVoice HTTP API](https://platform.qianwenai.com/docs/api-reference/speech-synthesis/cosyvoice-nrt/http-api)
- [Qwen3-TTS API](https://platform.qianwenai.com/docs/api-reference/speech-synthesis/qwen-tts)
- [MiniMax 同步语音合成 API](https://platform.qianwenai.com/docs/api-reference/speech-synthesis/minimax-tts)