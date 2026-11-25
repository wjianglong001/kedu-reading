import { useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, BookOpenText, ListChecks } from '@phosphor-icons/react'
import type { Question } from './types'

export function ReaderWorkspace({ title, progress, timer, onBack, passage, questions }: {
  title: string
  progress: string
  timer?: ReactNode
  onBack: () => void
  passage: ReactNode
  questions: ReactNode
}) {
  const [pane, setPane] = useState<'passage' | 'questions'>('passage')
  const questionTab = useRef<HTMLButtonElement>(null)
  return <div className="reader-workspace" data-pane={pane}>
    <header className="reader-bar">
      <button className="icon-button" onClick={onBack} aria-label="返回首页"><ArrowLeft /></button>
      <strong>{title}</strong><span className="reader-progress">{progress}</span>{timer}
    </header>
    <nav className="reader-switch" aria-label="作答视图">
      <button aria-pressed={pane === 'passage'} onClick={() => setPane('passage')}><BookOpenText />原文</button>
      <button ref={questionTab} aria-pressed={pane === 'questions'} onClick={() => setPane('questions')}><ListChecks />题目</button>
    </nav>
    <div className="exam-layout">
      <article className="reading-sheet">{passage}
        <button className="text-button read-next" onClick={() => { setPane('questions'); questionTab.current?.focus() }}>去答题 <ArrowRight /></button>
      </article>
      <section className="question-sheet" aria-label="阅读题目">{questions}</section>
    </div>
  </div>
}

export function AnswerQuestion({ question, number, answer, onChange, locked = false }: {
  question: Pick<Question, 'id' | 'stem' | 'options'>
  number: number
  answer?: string
  onChange: (value: string) => void
  locked?: boolean
}) {
  return <fieldset className="question" disabled={locked}>
    <legend><span>{number}</span>{question.stem}</legend>
    <div className="options">{Object.entries(question.options).map(([key, value]) =>
      <label key={key} className={answer === key ? 'chosen' : ''}>
        <input type="radio" name={question.id} value={key} checked={answer === key} onChange={() => onChange(key)} />
        <span>{key}</span><p>{value}</p>
      </label>
    )}</div>
  </fieldset>
}
