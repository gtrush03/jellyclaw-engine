import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { Text, Box } from "ink";
import TextInput from "ink-text-input";

function Probe() {
  const [v, setV] = React.useState("");
  return (
    <Box flexDirection="column">
      <Text>raw:[{v}]</Text>
      <TextInput
        value={v}
        onChange={(s) => {
          console.error("ONCHANGE:", JSON.stringify(s));
          setV(s);
        }}
        onSubmit={(s) => console.error("SUBMIT:", JSON.stringify(s))}
      />
    </Box>
  );
}

describe("debug", () => {
  it("textinput", async () => {
    const { stdin } = render(<Probe />);
    // settle
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    stdin.write("abcdef");
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    stdin.write("\r");
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    expect(true).toBe(true);
  });
});
