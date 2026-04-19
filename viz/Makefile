.PHONY: recipe-basic recipe-timeout recipe-chained recipe-handoff-claim recipe-handoff-timeout recipe-basic-hq recipe-timeout-hq recipe-chained-hq recipe-handoff-claim-hq recipe-handoff-timeout-hq all-recipes clean list preview-basic preview-timeout preview-chained preview-handoff-claim preview-handoff-timeout

# Per-recipe synthetic scenes — low quality for iteration; bump to -qh
# for sharing.

recipe-basic:
	manim -ql scenes/recipe_basic.py RecipeBasic

recipe-timeout:
	manim -ql scenes/recipe_timeout.py RecipeTimeout

recipe-chained:
	manim -ql scenes/recipe_chained.py RecipeChained

recipe-handoff-claim:
	manim -ql scenes/recipe_handoff.py RecipeHandoffClaim

recipe-handoff-timeout:
	manim -ql scenes/recipe_handoff.py RecipeHandoffTimeout

all-recipes: recipe-basic recipe-timeout recipe-chained recipe-handoff-claim recipe-handoff-timeout

# High-quality renders (scale up wall time; use for final versions).

recipe-basic-hq:
	manim -qh scenes/recipe_basic.py RecipeBasic

recipe-timeout-hq:
	manim -qh scenes/recipe_timeout.py RecipeTimeout

recipe-chained-hq:
	manim -qh scenes/recipe_chained.py RecipeChained

recipe-handoff-claim-hq:
	manim -qh scenes/recipe_handoff.py RecipeHandoffClaim

recipe-handoff-timeout-hq:
	manim -qh scenes/recipe_handoff.py RecipeHandoffTimeout

# Preview in the default system player (opens window after render).

preview-basic:
	manim -pql scenes/recipe_basic.py RecipeBasic

preview-timeout:
	manim -pql scenes/recipe_timeout.py RecipeTimeout

preview-chained:
	manim -pql scenes/recipe_chained.py RecipeChained

preview-handoff-claim:
	manim -pql scenes/recipe_handoff.py RecipeHandoffClaim

preview-handoff-timeout:
	manim -pql scenes/recipe_handoff.py RecipeHandoffTimeout

list:
	@ls scenes/*.py

clean:
	rm -rf media/
