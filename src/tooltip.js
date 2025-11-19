export class Tooltip
{
    constructor(element, text)
    {
        this.element = element;
        this.text = text;
        this.tooltip = null;

        this.element.addEventListener('mouseenter', this.show.bind(this));
        this.element.addEventListener('mouseleave', this.hide.bind(this));
    }

    show()
    {
        this.tooltip = document.createElement('div');
        this.tooltip.className = 'custom-tooltip';
        this.tooltip.textContent = this.text;
        document.body.appendChild(this.tooltip);

        const rect = this.element.getBoundingClientRect();
        const tooltipRect = this.tooltip.getBoundingClientRect();

        // Position above the element
        let top = rect.top - tooltipRect.height - 10;
        let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);

        let positionClass = 'tooltip-top';

        // Adjust if off screen
        if (top < 0)
        {
            top = rect.bottom + 10;
            positionClass = 'tooltip-bottom';
        }
        if (left < 0)
        {
            left = 10;
        }
        if (left + tooltipRect.width > window.innerWidth)
        {
            left = window.innerWidth - tooltipRect.width - 10;
        }

        this.tooltip.classList.add(positionClass);
        this.tooltip.style.top = `${top}px`;
        this.tooltip.style.left = `${left}px`;

        // Trigger reflow to enable transition
        void this.tooltip.offsetWidth;

        this.tooltip.classList.add('visible');
    }

    hide()
    {
        if (this.tooltip)
        {
            this.tooltip.classList.remove('visible');
            // Remove after transition
            setTimeout(() =>
            {
                if (this.tooltip && !this.tooltip.classList.contains('visible'))
                {
                    this.tooltip.remove();
                    this.tooltip = null;
                }
            }, 200);
        }
    }
}
