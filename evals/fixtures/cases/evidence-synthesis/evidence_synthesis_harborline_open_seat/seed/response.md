# Evidence — harborline-freight.example

## Company
- Harborline Freight is a family-owned regional LTL and drayage carrier on the Gulf Coast, operating since 1987. [inputs/firecrawl-homepage.md · fact]
- Four terminals (Mobile, Gulfport, Lake Charles, Beaumont), 180 tractors and 410 trailers; 240 people per the posting. [inputs/firecrawl-homepage.md · fact] [inputs/posting-head-of-operations-technology.md · fact]
- Third-generation ownership: the CEO joined the family business in 2004. [inputs/firecrawl-leadership.md · fact]
- The company states it moves freight and does not build software for sale. [inputs/posting-head-of-operations-technology.md · fact]

## Leadership map
- Ruth Ashgrove — Chief Executive Officer. [inputs/firecrawl-leadership.md · fact]
- Desmond Ferreira-Kole — Chief Operating Officer; runs the four terminals and dispatch. [inputs/firecrawl-leadership.md · fact]
- Anneliese Brackwater — Chief Financial Officer. [inputs/firecrawl-leadership.md · fact]
- Kwame Tannerhill — VP Operations; linehaul, drayage and driver staffing. [inputs/firecrawl-leadership.md · fact]
- Marisol Ferrante — Director of IT; keeps the network, phones, laptops and TMS running. [inputs/firecrawl-leadership.md · fact]
- Beatrix Oyelaran — Director of Safety & Compliance. [inputs/firecrawl-leadership.md · fact]
- No one on the leadership page or in the people sweep carries an AI, automation or data title. [inputs/firecrawl-leadership.md · fact] [inputs/apollo-people.json · fact]
- Read: nobody owns the AI/automation function today — the Director of IT's remit stops at infrastructure and the mandate is written into an open seat. [inputs/firecrawl-leadership.md · inference · sensitive]

## The signal
- Open posting: Head of Operations Technology, posted 2026-02-10, reporting to the COO. [inputs/posting-head-of-operations-technology.md · fact]
- The posting assigns the AI and automation roadmap for dispatch, billing and customer service to this unfilled role and states there is no technology leader beyond infrastructure and helpdesk. [inputs/posting-head-of-operations-technology.md · fact]
- Read: the mandate sits inside the open seat rather than with any current incumbent, so the buyer is the COO the seat reports to. [inputs/posting-head-of-operations-technology.md · inference]

## Posture
- Dispatch, billing and customer service run on a TMS, spreadsheets and phone calls. [inputs/posting-head-of-operations-technology.md · fact · sensitive]
- The COO is on record that the hand-rebuilt dispatch board "does not scale to a fifth yard" and that a technology leader is being hired to change it. [inputs/firecrawl-press-terminal-expansion.md · fact]
- Read: adoption today is nil beyond the TMS; the expansion is the forcing function. [inputs/firecrawl-press-terminal-expansion.md · inference]

## Angles
- Grounded instance — the daily linehaul dispatch board: dispatchers rebuild it by hand every morning before 6am from the TMS and overnight driver call-ins. [inputs/posting-head-of-operations-technology.md · fact] [inputs/firecrawl-press-terminal-expansion.md · fact]
- Who runs it: the dispatch team under the COO, who owns terminals and dispatch. [inputs/firecrawl-leadership.md · fact]
- Current failure mode: manual rebuild each morning, which the COO says will not scale to a fifth terminal. [inputs/firecrawl-press-terminal-expansion.md · fact]
- Pilot metric candidate: minutes from first driver call-in to a published board, or corrections made to the board after 6am. [inputs/posting-head-of-operations-technology.md · hypothesis]
- Entry point: COO Desmond Ferreira-Kole — the seat reports to him and he is quoted on the problem. [inputs/posting-head-of-operations-technology.md · fact] [inputs/firecrawl-press-terminal-expansion.md · fact]
- Timing: the fifth terminal opens Q3 2026, so the seat is likely to be filled or the problem escalated before then. [inputs/firecrawl-press-terminal-expansion.md · inference]
