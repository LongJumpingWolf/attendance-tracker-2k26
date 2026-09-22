"use client"

import { useEffect, useState } from "react"

export function useClientDate(format?: Intl.DateTimeFormatOptions) {
  const [formattedDate, setFormattedDate] = useState("")

  useEffect(() => {
    const updateDate = () => {
      const now = new Date()
      const options: Intl.DateTimeFormatOptions = format || { 
        year: "numeric", 
        month: "short", 
        day: "numeric" 
      }
      setFormattedDate(now.toLocaleDateString("en-US", options).toUpperCase())
    }

    updateDate()
    const interval = setInterval(updateDate, 60000) // Update every minute
    return () => clearInterval(interval)
  }, [format])

  return formattedDate
}

interface ClientDateProps {
  format?: Intl.DateTimeFormatOptions
  className?: string
}

export default function ClientDate({ format, className }: ClientDateProps) {
  const formattedDate = useClientDate(format)
  
  if (!formattedDate) {
    return null // or a loading placeholder
  }

  return <span className={className}>{formattedDate}</span>
}