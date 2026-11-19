# Vocabulary and audio sources

Application code uses the [MIT License](./LICENSE). The vocabulary and dictionary are separate adapted works distributed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Preserve their attribution and share-alike requirements when redistributing adaptations.

## Starter vocabulary

The 2,593-card Open starter set is a filtered and reformatted subset of [slovymovy/words at revision bbef653dc3737361949403c36c822cda61cff512](https://github.com/slovymovy/words/tree/bbef653dc3737361949403c36c822cda61cff512), based on Wiktionary content processed by [Kaikki.org](https://kaikki.org/) and [Wiktextract](https://github.com/tatuylonen/wiktextract).

The adaptation combines ten topic lists with the first 3,000 unique alphabetic terms considered from the German frequency list, retaining source-labeled A1/A2 senses with English meanings and translated examples. It deduplicates lexical entries, reformats fields for the app, and adds core/topic tags. There are 919 source-labeled A1 and 1,674 A2 cards. Core vocabulary covers 2,171 cards and overlaps the topics: Health, Clothes, Food, Feelings, Family, Nature, Time and numbers, School, Travel and Work.

This is independent supplemental vocabulary, not a vhs-Lernportal or Goethe course list. Source labels, glosses and examples are not independently validated and can contain errors. Upstream requests this academic citation: Tatu Ylonen, “Wiktextract: Wiktionary as Machine-Readable Structured Data,” LREC 2022.

## Dictionary

[src/data/german-dictionary.json](./src/data/german-dictionary.json) adapts German entries from English Wiktionary as extracted by Wiktextract and published by [Kaikki.org](https://kaikki.org/dictionary/German/). The file records its source date, license and modifications. Frequency selection/ranking uses the same pinned slovymovy list.

The adaptation keeps about 23,000 single-word entries at rank 30,000 or better, plus source-backed entries and form-of links needed by starter examples, up to four short glosses, noun article/plural, translated examples where supplied, and roughly 129,000 lookup forms. It removes inflected-form headword entries and obsolete, archaic or historical senses, and trims bracketed clarifications. About one in five entries has an example. Wiktionary content is available under CC BY-SA 4.0 and GFDL; this adapted subset uses CC BY-SA 4.0.

Dictionary glosses are short and context-free, not sentence translations. Unrecorded senses, compounds, names and variants can be missing. The separate dictionary downloads on first use and can then work offline; it is not part of the startup app bundle.

## Pronunciation and examples

The pronunciation catalogue matches all 2,593 current starter cards to human word recordings and also includes some plural forms. Sources come from German Wiktionary audio references in Kaikki's extract. The builder checks each Commons file's creator and an accepted free license; records lacking usable metadata or using noncommercial licenses are excluded or replaced with a source-listed alternative. A small explicit attribution supplement records author statements checked in older Commons descriptions, without treating the uploader as the creator.

Each entry carries its Commons source, author and individual CC BY, CC BY-SA, CC0 or public-domain status. The original audio content is not edited; MP3 transcoding is disclosed. Recordings omit articles unless present in the source. They are not bundled or app-cached, and are requested directly from Commons only on Listen. The lightweight catalogue itself is a separate app asset. Matching does not guarantee the appropriate pronunciation of every homograph in every context. Imported words and phrases can still lack recordings.

German browser voices are detected as their list becomes available. Local speech is preferred; remote browser speech is offered as a separate explicit action with a disclosure that the word is sent. This does not install an offline voice model. Regenerate and check coverage with `npm run data:pronunciation`.


German example words offer dictionary lookup across Learn and revealed review cards. Exact English counterpart highlights remain limited to a verified German/English sentence pair. Dictionary glosses do not establish sentence alignments. The dictionary records coverage against starter example tokens and leaves uncovered words explicit. Imported and learner-written content remains the learner's responsibility to check.

For regeneration commands and development setup, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Missing noun forms

`noun-form-supplement.json` is a curated, CC BY-SA 4.0 supplement for the 174 starter noun cards without plural values. Forty have checked plural suggestions, three have a verified usually-singular status and one a usually-plural status; 130 remain explicitly unknown. Entries link to their Wiktionary source and match exact word, article and meaning. Financial Bank uses Banken; the bench sense uses Bänke. Wort's Wörter suggestion is qualified as individual words. Do not regenerate these decisions from a spelling-level table or treat unknown as having no plural. Suggestions only become a learner's saved plural through an explicit action.

## Optional offline voice package

The separately GPL-3.0-or-later [offline voice component](./optional/german-voice/README.md) builds its phonemizer from pinned eSpeak and Piper source. Its generated release includes corresponding source, the compatibility patch, build recipe, ONNX Runtime Web notices and the Thorsten model card and repository terms. The [NOTICE](./optional/german-voice/NOTICE) identifies the exact sources and keeps recording data, model weights and program licenses distinct. Synthesized speech is not a human recording and can mispronounce imported names or phrases. Installation is explicit, about 77 MB, with source available separately. No study text goes to a speech service. An opt-in preview is available for physical-device testing. Desktop offline checks pass; physical iOS/Android checks remain outstanding, and the preview is not a stable compatibility guarantee.
