import { useState } from 'react'
import { AnswerQuestion, ReaderWorkspace } from './ReaderWorkspace'

const evidence = 'When the library began closing an hour later on Tuesdays, evening visits doubled, even though its collection stayed the same.'
const question = {
  id: 'sample-library', stem: 'What does the Tuesday experiment suggest?',
  options: {
    A: 'Readers wanted a wider selection of books.',
    B: 'Opening hours had prevented some readers from visiting.',
    C: 'Most visitors preferred to read in the evening.',
    D: 'Evening visitors borrowed twice as many books.',
  },
}

export default function SampleReading({ onBack, onTrain }: { onBack: () => void; onTrain: () => void }) {
  const [answer, setAnswer] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [translated, setTranslated] = useState(false)
  return <ReaderWorkspace title="阅读样题" progress={submitted ? '已完成' : '1 道推理题'} onBack={onBack}
    passage={<>
      <p className="eyebrow">社会与文化 · 短篇</p><h1>The Library After Six</h1>
      <button className="translation-toggle sample-translate" aria-pressed={translated} onClick={() => setTranslated(!translated)}>{translated ? '隐藏译文' : '查看译文'}</button>
      <div className="passage-copy"><div className="paragraph"><span>1</span>
        <p>At six each evening, the town library closed just as the buses from the factory reached the square. The librarian often saw workers pause outside to read the opening hours before walking on.</p>
        {translated && <p className="translation">每天傍晚六点，工厂班车驶入广场时，镇上的图书馆刚好关门。馆员常看见工人们在门口停下来，看看开放时间，然后离开。</p>}
      </div><div className="paragraph"><span>2</span><p><mark className={submitted ? 'evidence-mark' : 'plain-mark'}>{evidence}</mark> The librarian decided to test the later closing time on a second evening before ordering more books.</p>
        {translated && <p className="translation">图书馆试着在周二晚关门一小时。虽然藏书没有变化，晚间到访人次却翻了一番。馆员决定再选一个晚上试行延时闭馆，然后再考虑添购图书。</p>}
      </div></div>
    </>}
    questions={<>
      <p className="eyebrow">推理判断</p>
      <AnswerQuestion question={question} number={1} answer={answer} onChange={setAnswer} locked={submitted} />
      {submitted ? <div className="sample-feedback" role="status">
        <h2>{answer === 'B' ? '答对了' : '正确答案是 B'}</h2>
        <p>藏书没变，延时开放后到访人次就增加了。这说明原来的开放时间让一部分读者赶不上。</p>
        <blockquote>{evidence}</blockquote>
        <button className="primary-button" onClick={onTrain}>开始我的训练</button>
      </div> : <button className="primary-button submit-button" disabled={!answer} onClick={() => setSubmitted(true)}>查看答案与依据</button>}
    </>}
  />
}
