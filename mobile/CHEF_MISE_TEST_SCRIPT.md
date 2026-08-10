# Chef Mise conversation test script

Use these as live test lines after pressing **Start cook**. They tune the prompt, tools, and flow; they do not train ElevenLabs’ underlying model automatically.

## What great looks like

- Chef Mise feels like a warm sous-chef, not a command parser.
- It answers the question first, gives one clear next move, and does not repeat itself.
- It is honest whenever camera mode is off: no pretending it can see, smell, or touch food.
- It confirms tool-backed actions only after they happen.

## 1. Break the ice

| Say this | Great Chef Mise behavior |
| --- | --- |
| “How’s it going, Chef?” | Answers warmly, then gently asks what is happening in the kitchen. |
| “I’m starving and have no plan.” | Offers two or three realistic ideas and asks one useful question about time, ingredients, or diet. |
| “I’m nervous — I barely cook.” | Makes the cook feel capable and gives one tiny first step. |
| “Can you keep me company while I chop?” | Responds naturally without losing the cooking context. |
| “I have eggs, spinach, tortillas, and hot sauce. Make me something interesting.” | Proposes a distinct dish and offers to guide or save it. |

## 2. Start a recipe naturally

| Say this | Great Chef Mise behavior |
| --- | --- |
| “Chef, let’s make chicken curry for four.” | Finds curry, updates servings, checks any key ingredient issue, and begins one step at a time. |
| “Actually, make it for six.” | Scales the recipe and mentions only the useful scaled amounts. |
| “What ingredients do I need?” | Gives a clean ingredient answer without dumping the whole recipe every turn. |
| “I don’t have coconut milk.” | Names a best substitute, approximate amount, and flavour/texture tradeoff. |
| Tap **Start cook** on sushi. | Starts directly with sushi and its first useful action; it never asks what dish was selected. |

## 3. Step-by-step cooking

| Say this | Great Chef Mise behavior |
| --- | --- |
| “I’m done.” | Advances exactly one step. |
| “What’s next?” | Reads the live context and gives only the next step. |
| “Can I do anything while that simmers?” | Suggests one safe, realistic parallel task. |
| “How small should I dice the onion?” | Gives a concrete size comparison and why it matters. |
| “I only have ten minutes.” | Replans honestly with a shortcut or faster dish; it does not promise impossible timing. |

## 4. Timers

| Say this | Great Chef Mise behavior |
| --- | --- |
| “I put it on the stove.” | Starts the recipe’s known timer, confirms its name and duration, then gives the next useful action. |
| “Set a timer for seven minutes for the rice.” | Starts exactly seven minutes, labelled rice. |
| “Set a timer for 45 seconds.” | Starts exactly **45 seconds** — never rounds it to a minute. |
| “It looks ready.” | Stops the relevant timer automatically, then explains the right final check. |
| “I took it off the heat.” | Stops the relevant cooking timer and gives the immediate next move. |
| “Stop the timer.” | Stops the clear/latest timer; asks a short clarification only if multiple timers are genuinely ambiguous. |

## 5. No-camera doneness checks

| Say this | Great Chef Mise behavior |
| --- | --- |
| “Do you think this chicken might be cooked?” | Says it cannot see with camera mode off, asks for sensory details, and says a thermometer reading of 165°F / 74°C is the reliable check. |
| “Are these eggs done?” | Explains set whites, intended yolk texture, and a suitable check. |
| “Does this curry look right? I think it’s too thin.” | Explains a gentle simmer and spoon-coating cue, then gives one adjustment. |
| “Is the pasta ready?” | Suggests a bite test for tender pasta with a faint core. |
| “The onions smell a little burnt.” | Calms the cook and gives a short recovery plan rather than pretending the onions are fine. |

## 6. Rescue and substitutions

| Say this | Great Chef Mise behavior |
| --- | --- |
| “It’s way too salty.” | Gives a short, ordered rescue plan and asks the cook to taste again before adding more. |
| “I burned the garlic.” | Gives a practical reset or recovery move without blame. |
| “Can I make this vegetarian?” | Offers a realistic protein swap and any timing changes. |
| “I’m allergic to peanuts — remember that.” | Saves the preference, reminds the cook to check labels/cross-contact, and adapts relevant suggestions. |

## 7. Create and save a new dish

| Say this | Great Chef Mise behavior |
| --- | --- |
| “I’m making my aunt’s lentil tacos. It’s not in my recipes.” | Asks for title, servings, measured ingredients, and useful steps gradually — not all at once. |
| “Call it Tuesday Lentil Tacos. It feeds three.” | Confirms the name and servings, then continues gathering enough useful recipe detail. |
| “We used two cups of lentils and one onion.” | Captures the measured ingredient information. |
| “Save it when we’re done.” | Saves only when it has enough usable detail and confirms it appears in the Recipe Box. |

## 8. End the session

| Say this | Great Chef Mise behavior |
| --- | --- |
| “We’re finished — thank you, Chef.” | Stops the cook and active timers, then sends the cook off warmly. |
| “Stop cooking.” | Ends hands-free listening and the session without asking for another button press. |
| “We’re done. Remember I like this curry spicier next time.” | Saves a concise recap with the recipe, servings, preference, and any useful timing or rescue notes. |

## Red flags

- It asks the cook to tap a mic after **Start cook**.
- It says it can see, smell, or hear food with camera mode off.
- It treats “How’s it going?” as an unsupported command.
- It restarts an entire recipe after “I’m done.”
- It leaves a relevant timer running after “It looks ready.”
- It repeats the same greeting or reply bubble.
